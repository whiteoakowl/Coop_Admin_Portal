const express = require('express');
const router = express.Router();
const db = require('../db');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { getMemberRostersForDate } = require('../utils/rosters');

function loadParents() {
  return db
    .prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY name COLLATE NOCASE")
    .all();
}

// Students eligible to be marked absent/late: linked to a parent (parent_id)
// and on the admin-curated Absence/Late opt-in list, same as before - the
// parent-picker just makes it faster to find your family's names.
function loadChildrenByParent() {
  const rows = db
    .prepare(
      `SELECT m.id, m.name, m.parent_id AS parentId
       FROM members m
       JOIN absence_list_members alm ON alm.member_id = m.id
       WHERE m.active = 1 AND m.member_type = 'student' AND m.parent_id IS NOT NULL
       ORDER BY m.name COLLATE NOCASE`
    )
    .all();
  const byParent = {};
  for (const r of rows) {
    if (!byParent[r.parentId]) byParent[r.parentId] = [];
    byParent[r.parentId].push({ id: r.id, name: r.name });
  }
  return byParent;
}

function loadEligibleStudent(studentId, parentId) {
  return db
    .prepare(
      `SELECT m.* FROM members m
       JOIN absence_list_members alm ON alm.member_id = m.id
       WHERE m.id = ? AND m.parent_id = ? AND m.active = 1 AND m.member_type = 'student'`
    )
    .get(studentId, parentId);
}

router.get('/absence', (req, res) => {
  res.render('absence', {
    title: 'Absence/Late Form',
    parents: loadParents(),
    childrenByParent: loadChildrenByParent(),
    result: null,
    formValues: { type: 'absence', parentId: '', studentIds: [], sessionDate: '', reasonCategory: '', reason: '' },
  });
});

router.post('/absence/submit', (req, res) => {
  const type = req.body.type === 'late' ? 'late' : 'absence';
  const parentId = parseInt(req.body.parentId, 10);
  const studentIds = [].concat(req.body.studentIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const sessionDate = (req.body.sessionDate || '').trim();
  const reasonCategory = ['personal', 'medical'].includes(req.body.reasonCategory) ? req.body.reasonCategory : null;
  const reason = (req.body.reason || '').trim() || null;

  const parents = loadParents();
  const childrenByParent = loadChildrenByParent();
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

  const students = studentIds.map((id) => loadEligibleStudent(id, parentId)).filter(Boolean);
  if (students.length === 0) return fail('Please select at least one student.');

  if (!isValidISODate(sessionDate)) return fail('Please choose a class date.');
  if (!reasonCategory) return fail('Please select Personal or Medical.');

  let totalRosters = 0;
  let totalSkippedAsPresent = 0;
  const namesRecorded = [];

  for (const student of students) {
    const rosters = getMemberRostersForDate(student.id, sessionDate);
    if (rosters.length === 0) continue;

    let skippedAsPresent = 0;
    for (const roster of rosters) {
      const existing = db
        .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
        .get(student.id, roster.id, sessionDate);

      if (existing && existing.status === 'present') {
        skippedAsPresent++;
        continue;
      }

      const status = type === 'late' ? 'late' : 'absent';
      if (existing) {
        db.prepare(
          `UPDATE attendance SET status = ?, source = 'absence_form', reason_category = ?, reason_text = ?, recorded_at = datetime('now') WHERE id = ?`
        ).run(status, reasonCategory, reason, existing.id);
      } else {
        db.prepare(
          `INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category, reason_text)
           VALUES (?, ?, ?, ?, 'absence_form', ?, ?)`
        ).run(student.id, roster.id, sessionDate, status, reasonCategory, reason);
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
