const express = require('express');
const router = express.Router();
const db = require('../db');
const { activeMemberOptions, familyGroupsByMember, loadFamilyMemberAnyType } = require('../utils/members');
const { createRateLimiter } = require('../utils/rateLimit');
const { listActiveClassDays, CLASS_DAY_LABELS_FULL } = require('../utils/classSchedule');

const REQUEST_TYPES = ['lost_tag', 'schedule_change', 'new_tag'];

// Same reasoning as absence.js's own limiter - generous for real use,
// still a real cap on this public, no-login endpoint.
const submitLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

router.get('/name-tag', async (req, res) => {
  const members = await activeMemberOptions();
  res.render('name-tag', {
    title: 'Name Tag Form',
    members,
    familyByMember: await familyGroupsByMember(members),
    result: null,
    activeDays: await listActiveClassDays(),
    dayLabels: CLASS_DAY_LABELS_FULL,
    formValues: { memberId: '', memberIds: [], requestType: '', day: '', description: '' },
  });
});

router.post('/name-tag/submit', async (req, res) => {
  const activeDays = await listActiveClassDays();
  if (submitLimiter.isLimited(req.ip)) {
    const members = await activeMemberOptions();
    return res.render('name-tag', {
      title: 'Name Tag Form',
      members,
      familyByMember: await familyGroupsByMember(members),
      activeDays,
      dayLabels: CLASS_DAY_LABELS_FULL,
      formValues: { memberId: '', memberIds: [], requestType: '', day: '', description: '' },
      result: { ok: false, message: 'Too many submissions from this device. Please wait a few minutes and try again.' },
    });
  }
  submitLimiter.recordAttempt(req.ip);

  const requesterId = parseInt(req.body.memberId, 10);
  const targetIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const requestType = REQUEST_TYPES.includes(req.body.requestType) ? req.body.requestType : null;
  const day = [...activeDays, 'both'].includes(req.body.day) ? req.body.day : null;
  const description = (req.body.description || '').trim() || null;

  const members = await activeMemberOptions();
  const familyByMember = await familyGroupsByMember(members);
  const formValues = {
    memberId: req.body.memberId || '',
    memberIds: targetIds,
    requestType: req.body.requestType || '',
    day: req.body.day || '',
    description: req.body.description || '',
  };

  function fail(message) {
    return res.render('name-tag', { title: 'Name Tag Form', members, familyByMember, activeDays, dayLabels: CLASS_DAY_LABELS_FULL, formValues, result: { ok: false, message } });
  }

  const requester = requesterId ? members.find((m) => m.id === requesterId) : null;
  if (!requester) return fail('Please select your name.');

  const targets = [];
  for (const id of targetIds) {
    const target = await loadFamilyMemberAnyType(id, requesterId);
    if (target) targets.push(target);
  }
  if (targets.length === 0) return fail('Please select at least one name.');

  if (!requestType) return fail('Please select New Name Tag, Lost Name Tag, or Schedule Change.');
  if (!day) return fail('Please select a day, or Both.');

  const insert = db.prepare('INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, ?, ?, ?)');
  for (const target of targets) await insert.run(target.id, requestType, day, description);

  const names = targets.map((t) => t.name).join(', ');

  res.render('name-tag', {
    title: 'Name Tag Form',
    members,
    familyByMember,
    activeDays,
    dayLabels: CLASS_DAY_LABELS_FULL,
    formValues: { memberId: '', memberIds: [], requestType: '', day: '', description: '' },
    result: { ok: true, message: `Request submitted for ${names}.`, redirectHome: true },
  });
});

module.exports = router;
