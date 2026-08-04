const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { todayISO } = require('../utils/dates');
const { buildTemplateWorkbook } = require('../utils/spreadsheet');

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

// Today's checked-in/out/late/absent counts for one member type, each as
// "X of Y" against every active member of that type (not just those on a
// roster today, so the denominator reads as a stable roster size).
function todayStatsForType(memberType, today) {
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = ?`)
    .get(memberType).c;
  const checkedIn = db
    .prepare(
      `SELECT COUNT(DISTINCT a.member_id) AS c FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.session_date = ? AND a.status = 'present' AND m.member_type = ?`
    )
    .get(today, memberType).c;
  const checkedOut = db
    .prepare(
      `SELECT COUNT(DISTINCT c.member_id) AS c FROM checkouts c
       JOIN members m ON m.id = c.member_id
       WHERE c.session_date = ? AND m.member_type = ?`
    )
    .get(today, memberType).c;
  const late = db
    .prepare(
      `SELECT COUNT(DISTINCT a.member_id) AS c FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.session_date = ? AND a.status = 'late' AND m.member_type = ?`
    )
    .get(today, memberType).c;
  const absent = db
    .prepare(
      `SELECT COUNT(DISTINCT a.member_id) AS c FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.session_date = ? AND a.status = 'absent' AND m.member_type = ?`
    )
    .get(today, memberType).c;

  return { total, checkedIn, checkedOut, late, absent };
}

router.get('/', requireAdmin, (req, res) => {
  const today = todayISO();
  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM members WHERE active = 1').get().c;
  const studentCount = db.prepare("SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = 'student'").get().c;
  const parentCount = db.prepare("SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = 'parent'").get().c;

  res.render('admin-dashboard', {
    title: 'Dashboard',
    memberCount,
    studentCount,
    parentCount,
    studentStats: todayStatsForType('student', today),
    parentStats: todayStatsForType('parent', today),
  });
});

// Shared "names only" import template for Rosters, Floater Assignments, and
// Absence/Late - those pages only ever link an existing Members-page
// profile by name, never create one.
router.get('/import-template/names.xlsx', requireAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(['Name'], [['Alice Smith'], ['Bob Jones']]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import-names-template.xlsx"');
  res.send(buffer);
});

// --- Settings ---

const SETTINGS_TABS = ['account', 'quicklinks'];

function renderSettings(req, res, error, success, activeTab) {
  res.render('admin-settings', {
    title: 'Settings',
    username: req.session.username,
    activeTab: SETTINGS_TABS.includes(activeTab) ? activeTab : 'account',
    error,
    success,
  });
}

router.get('/settings', requireAdmin, (req, res) => {
  renderSettings(req, res, req.query.error || null, req.query.notice || null, req.query.tab);
});

router.post('/settings/username', requireAdmin, (req, res) => {
  const newUsername = (req.body.newUsername || '').trim();

  if (!newUsername) return renderSettings(req, res, 'New username is required.', null, 'account');

  const taken = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?').get(newUsername, req.session.adminId);
  if (taken) return renderSettings(req, res, 'That username is already in use.', null, 'account');

  db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(newUsername, req.session.adminId);
  req.session.username = newUsername;
  renderSettings(req, res, null, 'Username updated.', 'account');
});

router.post('/settings/password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);

  if (!admin || !bcrypt.compareSync(currentPassword || '', admin.password_hash)) {
    return renderSettings(req, res, 'Current password is incorrect.', null, 'account');
  }
  if (!newPassword || newPassword.length < 8) {
    return renderSettings(req, res, 'New password must be at least 8 characters.', null, 'account');
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  renderSettings(req, res, null, 'Password updated.', 'account');
});

module.exports = router;
