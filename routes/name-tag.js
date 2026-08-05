const express = require('express');
const router = express.Router();
const db = require('../db');
const { activeParentOptions, familyGroupsByParent, loadFamilyMember } = require('../utils/members');

const REQUEST_TYPES = ['lost_tag', 'schedule_change'];
const DAYS = ['monday', 'wednesday', 'both'];

router.get('/name-tag', (req, res) => {
  res.render('name-tag', {
    title: 'Name Tag Form',
    parents: activeParentOptions(),
    childrenByParent: familyGroupsByParent(),
    result: null,
    formValues: { parentId: '', memberIds: [], requestType: '', day: '', description: '' },
  });
});

router.post('/name-tag/submit', (req, res) => {
  const parentId = parseInt(req.body.parentId, 10);
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const requestType = REQUEST_TYPES.includes(req.body.requestType) ? req.body.requestType : null;
  const day = DAYS.includes(req.body.day) ? req.body.day : null;
  const description = (req.body.description || '').trim() || null;

  const parents = activeParentOptions();
  const childrenByParent = familyGroupsByParent();
  const formValues = {
    parentId: req.body.parentId || '',
    memberIds,
    requestType: req.body.requestType || '',
    day: req.body.day || '',
    description: req.body.description || '',
  };

  function fail(message) {
    return res.render('name-tag', { title: 'Name Tag Form', parents, childrenByParent, formValues, result: { ok: false, message } });
  }

  const parent = parentId ? parents.find((p) => p.id === parentId) : null;
  if (!parent) return fail('Please select your name.');

  const members = memberIds.map((id) => loadFamilyMember(id, parentId)).filter(Boolean);
  if (members.length === 0) return fail('Please select at least one name.');

  if (!requestType) return fail('Please select Lost Name Tag or Schedule Change.');
  if (!day) return fail('Please select Monday, Wednesday, or Both.');

  const insert = db.prepare('INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, ?, ?, ?)');
  for (const member of members) insert.run(member.id, requestType, day, description);

  const names = members.map((m) => m.name).join(', ');

  res.render('name-tag', {
    title: 'Name Tag Form',
    parents,
    childrenByParent,
    formValues: { parentId: '', memberIds: [], requestType: '', day: '', description: '' },
    result: { ok: true, message: `Request submitted for ${names}.`, redirectHome: true },
  });
});

module.exports = router;
