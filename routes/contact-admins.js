const express = require('express');
const router = express.Router();
const db = require('../db');

// Reachable from every portal's top bar (Admin, Co-op Admin, Parent,
// Student) - anyone with an active session, admin or portal member alike.
function requireAnySession(req, res, next) {
  if (req.session && (req.session.adminId || req.session.portalMemberId)) return next();
  res.redirect('/');
}

router.get('/contact-admins', requireAnySession, (req, res) => {
  const contacts = db.prepare('SELECT * FROM leadership_contacts ORDER BY position, role COLLATE NOCASE').all();
  res.render('contact-admins', {
    title: 'Contact Admins',
    contacts,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/contact-admins', requireAnySession, (req, res) => {
  const leadershipTeam = (req.body.leadershipTeam || '').trim();
  const senderEmail = (req.body.senderEmail || '').trim();
  const title = (req.body.title || '').trim();
  const message = (req.body.message || '').trim();

  if (!leadershipTeam || !senderEmail || !title || !message) {
    return res.redirect('/contact-admins?error=' + encodeURIComponent('Please fill in every field.'));
  }

  db.prepare(
    'INSERT INTO contact_admin_messages (leadership_team, sender_email, title, message) VALUES (?, ?, ?, ?)'
  ).run(leadershipTeam, senderEmail, title, message);

  res.redirect('/contact-admins?notice=' + encodeURIComponent('Your message was sent to the admin team.'));
});

module.exports = router;
