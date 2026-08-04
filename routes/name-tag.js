const express = require('express');
const router = express.Router();
const db = require('../db');

const REQUEST_TYPES = ['lost_tag', 'schedule_change'];
const DAYS = ['monday', 'wednesday', 'both'];

function loadParents() {
  return db
    .prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY name COLLATE NOCASE")
    .all();
}

// Every member is selectable - no separate opt-in list to manage. The
// parent-picker groups the full member list by family: the parent
// themselves, plus every student linked to them via parent_id.
function loadChildrenByParent() {
  const rows = db
    .prepare(
      `SELECT id, name, parent_id AS parentId
       FROM members
       WHERE active = 1 AND member_type = 'student' AND parent_id IS NOT NULL
       ORDER BY name COLLATE NOCASE`
    )
    .all();
  const byParent = {};
  for (const r of rows) {
    if (!byParent[r.parentId]) byParent[r.parentId] = [];
    byParent[r.parentId].push({ id: r.id, name: r.name });
  }
  return byParent;
}

function loadEligibleMember(memberId, parentId) {
  if (memberId === parentId) {
    return db.prepare("SELECT * FROM members WHERE id = ? AND active = 1 AND member_type = 'parent'").get(parentId);
  }
  return db
    .prepare("SELECT * FROM members WHERE id = ? AND parent_id = ? AND active = 1 AND member_type = 'student'")
    .get(memberId, parentId);
}

router.get('/name-tag', (req, res) => {
  res.render('name-tag', {
    title: 'Name Tag Form',
    parents: loadParents(),
    childrenByParent: loadChildrenByParent(),
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

  const parents = loadParents();
  const childrenByParent = loadChildrenByParent();
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

  const members = memberIds.map((id) => loadEligibleMember(id, parentId)).filter(Boolean);
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
