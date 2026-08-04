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
  const todayLate = db
    .prepare(`SELECT COUNT(*) AS c FROM attendance WHERE session_date = ? AND status = 'late'`)
    .get(today).c;
  const todayAbsent = db
    .prepare(`SELECT COUNT(*) AS c FROM attendance WHERE session_date = ? AND status = 'absent'`)
    .get(today).c;

  res.render('admin-dashboard', {
    title: 'Dashboard',
    username: req.session.username,
    memberCount,
    todayPresent,
    todayLate,
    todayAbsent,
    today,
  });
});

// --- Settings ---

function loadCategories() {
  return db.prepare('SELECT name FROM categories ORDER BY name COLLATE NOCASE').all().map((r) => r.name);
}

function renderSettings(req, res, error, success) {
  res.render('admin-settings', {
    title: 'Settings',
    username: req.session.username,
    categories: loadCategories(),
    error,
    success,
  });
}

router.get('/settings', requireAdmin, (req, res) => {
  renderSettings(req, res, req.query.error || null, req.query.notice || null);
});

router.post('/settings/username', requireAdmin, (req, res) => {
  const newUsername = (req.body.newUsername || '').trim();

  if (!newUsername) return renderSettings(req, res, 'New username is required.', null);

  const taken = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?').get(newUsername, req.session.adminId);
  if (taken) return renderSettings(req, res, 'That username is already in use.', null);

  db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(newUsername, req.session.adminId);
  req.session.username = newUsername;
  renderSettings(req, res, null, 'Username updated.');
});

router.post('/settings/password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);

  if (!admin || !bcrypt.compareSync(currentPassword || '', admin.password_hash)) {
    return renderSettings(req, res, 'Current password is incorrect.', null);
  }
  if (!newPassword || newPassword.length < 8) {
    return renderSettings(req, res, 'New password must be at least 8 characters.', null);
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  renderSettings(req, res, null, 'Password updated.');
});

module.exports = router;
