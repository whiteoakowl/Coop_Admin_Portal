const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { todayISO } = require('../utils/dates');

// --- Auth ---

router.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin-login', { title: 'Admin Login', error: null, next: req.query.next || '/admin' });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const next = req.body.next || '/admin';
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get((username || '').trim());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.render('admin-login', { title: 'Admin Login', error: 'Invalid username or password.', next });
  }
  req.session.adminId = admin.id;
  req.session.username = admin.username;
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Dashboard ---

router.get('/', requireAdmin, (req, res) => {
  const today = todayISO();
  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM members WHERE active = 1').get().c;
  const todayPresent = db
    .prepare(`SELECT COUNT(*) AS c FROM attendance WHERE session_date = ? AND status = 'present'`)
    .get(today).c;
  const todayCheckouts = db.prepare(`SELECT COUNT(*) AS c FROM checkouts WHERE session_date = ?`).get(today).c;
  const rosters = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM roster_members rm WHERE rm.roster_id = r.id) AS memberCount
       FROM rosters r WHERE r.active = 1 ORDER BY r.day, r.name COLLATE NOCASE`
    )
    .all();

  res.render('admin-dashboard', {
    title: 'Dashboard',
    username: req.session.username,
    memberCount,
    todayPresent,
    todayCheckouts,
    today,
    rosters,
  });
});

// --- Settings ---

router.get('/settings', requireAdmin, (req, res) => {
  res.render('admin-settings', { title: 'Settings', username: req.session.username, error: null, success: null });
});

router.post('/settings/password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);

  if (!admin || !bcrypt.compareSync(currentPassword || '', admin.password_hash)) {
    return res.render('admin-settings', { title: 'Settings', username: req.session.username, error: 'Current password is incorrect.', success: null });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.render('admin-settings', { title: 'Settings', username: req.session.username, error: 'New password must be at least 8 characters.', success: null });
  }
  if (newPassword !== confirmPassword) {
    return res.render('admin-settings', { title: 'Settings', username: req.session.username, error: 'New passwords do not match.', success: null });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  res.render('admin-settings', { title: 'Settings', username: req.session.username, error: null, success: 'Password updated.' });
});

module.exports = router;
