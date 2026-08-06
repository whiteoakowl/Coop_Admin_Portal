const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireMemberPortal = require('../middleware/requireMemberPortal');

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const member = db
    .prepare("SELECT * FROM members WHERE username = ? AND active = 1 AND password_hash IS NOT NULL")
    .get(username);

  if (!member || !bcrypt.compareSync(password, member.password_hash)) {
    return res.render('index', { title: 'SH Check-In / Check-Out', error: 'Invalid username or password.' });
  }

  req.session.portalMemberId = member.id;
  req.session.portalRole = member.member_type === 'student' ? 'student' : 'parent';
  res.redirect('/portal');
});

router.post('/portal/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/portal', requireMemberPortal, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.session.portalMemberId);
  if (!member) {
    req.session.destroy(() => res.redirect('/'));
    return;
  }
  res.render('portal-home', {
    title: `${req.session.portalRole === 'student' ? 'Student' : 'Parent'} Portal`,
    member,
    portalRole: req.session.portalRole,
  });
});

module.exports = router;
