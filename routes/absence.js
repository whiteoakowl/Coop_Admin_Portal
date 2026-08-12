const express = require('express');
const router = express.Router();
const db = require('../db');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');
const { activeParentOptions, familyGroupsByParent, loadFamilyMember } = require('../utils/members');
const { createRateLimiter } = require('../utils/rateLimit');

// Generous cap for real use (a parent reporting for several kids, or
// retrying after a typo) that still stops a script from hammering this
// public, no-login endpoint with repeated attendance-record writes.
const submitLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

router.get('/absence', async (req, res) => {
  res.render('absence', {
    title: 'Absence/Late Form',
    parents: await activeParentOptions(),
    childrenByParent: await familyGroupsByParent(),
    result: null,
    formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
  });
});

router.post('/absence/submit', async (req, res) => {
  if (submitLimiter.isLimited(req.ip)) {
    return res.render('absence', {
      title: 'Absence/Late Form',
      parents: await activeParentOptions(),
      childrenByParent: await familyGroupsByParent(),
      formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
      result: { ok: false, message: 'Too many submissions from this device. Please wait a few minutes and try again.' },
    });
  }
  submitLimiter.recordAttempt(req.ip);

  const type = req.body.type === 'late' ? 'late' : 'absence';
  const parentId = parseInt(req.body.parentId, 10);
  const studentIds = [].concat(req.body.studentIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const sessionDate = (req.body.sessionDate || '').trim();
  const reasonCategory = ['personal', 'medical'].includes(req.body.reasonCategory) ? req.body.reasonCategory : null;
  const reason = (req.body.reason || '').trim() || null;

  const parents = await activeParentOptions();
  const childrenByParent = await familyGroupsByParent();
  const formValues = {
    type,
    parentId: req.body.parentId || '',
    studentIds,
    sessionDate,
    reasonCategory: req.body.reasonCategory || '',
    reason: req.body.reason || '',
  };

  function fail(message) {
    return res.render('absence', { title: 'Absence/Late Form', parents, childrenByParent, formValues, result: { ok: false, message } });
  }

  const parent = parentId ? parents.find((p) => p.id === parentId) : null;
  if (!parent) return fail('Please select your name.');

  const students = [];
  for (const id of studentIds) {
    const student = await loadFamilyMember(id, parentId);
    if (student) students.push(student);
  }
  if (students.length === 0) return fail('Please select at least one name.');

  if (!isValidISODate(sessionDate)) return fail('Please choose a class date.');
  if (!reasonCategory) return fail('Please select Personal or Medical.');

  let totalRosters = 0;
  let totalSkippedAsPresent = 0;
  const namesRecorded = [];

  for (const student of students) {
    const rosters = await getMemberRostersForDate(student.id, sessionDate);
    if (rosters.length === 0) continue;

    let skippedAsPresent = 0;
    for (const roster of rosters) {
      const existing = await db
        .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
        .get(student.id, roster.id, sessionDate);

      if (existing && existing.status === 'present') {
        skippedAsPresent++;
        continue;
      }

      const status = type === 'late' ? 'late' : 'absent';
      if (existing) {
        await db
          .prepare(`UPDATE attendance SET status = ?, source = 'absence_form', reason_category = ?, reason_text = ?, recorded_at = now_text() WHERE id = ?`)
          .run(status, reasonCategory, reason, existing.id);
      } else {
        await db
          .prepare(
            `INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category, reason_text)
             VALUES (?, ?, ?, ?, 'absence_form', ?, ?)`
          )
          .run(student.id, roster.id, sessionDate, status, reasonCategory, reason);
      }
    }
    totalRosters += rosters.length;
    totalSkippedAsPresent += skippedAsPresent;
    namesRecorded.push(student.name);
  }

  if (namesRecorded.length === 0) {
    return fail(`None of the selected students are on a roster meeting on ${formatDateLabel(sessionDate)}.`);
  }

  const label = type === 'late' ? 'Late notice' : 'Absence';
  let message = `${label} recorded for ${namesRecorded.join(', ')} on ${formatDateLabel(sessionDate)}.`;
  if (totalSkippedAsPresent === totalRosters && totalRosters > 0) {
    message = `${namesRecorded.join(', ')} already checked in as present for ${formatDateLabel(sessionDate)}, so no change was made.`;
  } else if (totalSkippedAsPresent > 0) {
    message += ' (Anyone already checked in as present was left unchanged.)';
  }

  res.render('absence', {
    title: 'Absence/Late Form',
    parents,
    childrenByParent,
    formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
    result: { ok: true, message, redirectHome: true },
  });
});

module.exports = router;
