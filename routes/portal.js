const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireMemberPortal = require('../middleware/requireMemberPortal');

// Checked in priority order when a member has been granted more than one
// portal - Co-op Admin first (the more privileged surface), then Parent,
// then Student. The portal switcher (once a member is logged in) lets them
// move between every portal they're actually granted.
const PORTAL_ROLE_PRIORITY = ['coop_admin', 'parent', 'student'];

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const member = db
    .prepare("SELECT * FROM members WHERE username = ? AND active = 1 AND password_hash IS NOT NULL")
    .get(username);

  if (!member || !bcrypt.compareSync(password, member.password_hash)) {
    return res.render('index', { title: 'SH Check-In / Check-Out', error: 'Invalid username or password.' });
  }

  const grantedRoles = PORTAL_ROLE_PRIORITY.filter((role) => member[`portal_${role}`]);
  if (grantedRoles.length === 0) {
    return res.render('index', {
      title: 'SH Check-In / Check-Out',
      error: "This account doesn't have portal access yet. Ask a co-op admin to grant it.",
    });
  }

  req.session.portalMemberId = member.id;
  req.session.portalRoles = grantedRoles;
  req.session.portalRole = grantedRoles[0];
  res.redirect(grantedRoles[0] === 'coop_admin' ? '/admin' : '/portal');
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
