const express = require('express');
const router = express.Router();
const db = require('../db');

const REQUEST_TYPES = ['lost_tag', 'schedule_change'];
const DAYS = ['monday', 'wednesday', 'both'];

function loadMembers() {
  return db.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
}

router.get('/name-tag', (req, res) => {
  res.render('name-tag', {
    title: 'Name Tag Form',
    members: loadMembers(),
    result: null,
    formValues: { memberId: '', requestType: '', day: '', description: '' },
  });
});

router.post('/name-tag/submit', (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const requestType = REQUEST_TYPES.includes(req.body.requestType) ? req.body.requestType : null;
  const day = DAYS.includes(req.body.day) ? req.body.day : null;
  const description = (req.body.description || '').trim() || null;

  const formValues = {
    memberId: req.body.memberId || '',
    requestType: req.body.requestType || '',
    day: req.body.day || '',
    description: req.body.description || '',
  };

  const members = loadMembers();
  const member = memberId ? members.find((m) => m.id === memberId) : null;

  if (!member) {
    return res.render('name-tag', {
      title: 'Name Tag Form',
      members,
      formValues,
      result: { ok: false, message: 'Please select your name.' },
    });
  }
  if (!requestType) {
    return res.render('name-tag', {
      title: 'Name Tag Form',
      members,
      formValues,
      result: { ok: false, message: 'Please select Lost Name Tag or Schedule Change.' },
    });
  }
  if (!day) {
    return res.render('name-tag', {
      title: 'Name Tag Form',
      members,
      formValues,
      result: { ok: false, message: 'Please select Monday, Wednesday, or Both.' },
    });
  }

  db.prepare('INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, ?, ?, ?)').run(
    member.id,
    requestType,
    day,
    description
  );

  res.render('name-tag', {
    title: 'Name Tag Form',
    members,
    formValues: { memberId: '', requestType: '', day: '', description: '' },
    result: { ok: true, message: `Request submitted for ${member.name}.`, redirectHome: true },
  });
});

module.exports = router;
