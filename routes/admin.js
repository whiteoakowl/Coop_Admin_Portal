const express = require('express');
const router = express.Router();
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { todayISO } = require('../utils/dates');
const { buildTemplateWorkbook } = require('../utils/spreadsheet');
const { todaysAlerts } = require('../utils/alerts');
const { isRateLimited, recordFailure, recordSuccess } = require('../utils/loginRateLimit');
const { backupDatabaseBuffer, stageRestore, isRestoreStaged, cancelStagedRestore } = require('../utils/backup');
const { databaseFileFilter } = require('../utils/uploads');

// Restore uploads never touch disk (memoryStorage) - the whole file needs
// to be in hand before it can be validated as a real SQLite database. 200MB
// is generous headroom over any realistic co-op-scale database (the seed
// data used in this app's own testing lands in the hundreds of KB).
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: databaseFileFilter });

// --- Auth ---

// Only ever redirect back to a path within this app - an unvalidated
// `next` would let a crafted login link send a freshly-authenticated
// admin off-site (e.g. ?next=https://evil.example).
function safeNext(value) {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/admin';
}

router.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin-login', { title: 'Admin Login', error: null, next: safeNext(req.query.next) });
});

router.post('/login', (req, res) => {
  const next = safeNext(req.body.next);
  if (isRateLimited(req.ip)) {
    return res.render('admin-login', {
      title: 'Admin Login',
      error: 'Too many login attempts. Please wait a few minutes and try again.',
      next,
    });
  }

  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get((username || '').trim());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    recordFailure(req.ip);
    return res.render('admin-login', { title: 'Admin Login', error: 'Invalid username or password.', next });
  }
  recordSuccess(req.ip);
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
    alerts: todaysAlerts(),
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

const SETTINGS_TABS = ['account', 'quicklinks', 'install', 'documents'];
const FULL_ADMIN_ONLY_TABS = ['account', 'documents'];

function renderSettings(req, res, error, success, activeTab) {
  const isFullAdmin = !!req.session.adminId;
  // A Co-op Admin (a member, not the master admin account) only ever gets
  // Quick Links and Install App here - Username/Password manages the
  // single master admin account, and Documents is full-Admin-only.
  let tab = SETTINGS_TABS.includes(activeTab) ? activeTab : 'account';
  if (FULL_ADMIN_ONLY_TABS.includes(tab) && !isFullAdmin) tab = 'quicklinks';
  res.render('admin-settings', {
    title: 'Settings',
    username: req.session.username,
    isFullAdmin,
    activeTab: tab,
    documents: db.prepare('SELECT * FROM documents ORDER BY title COLLATE NOCASE').all(),
    restoreStaged: isRestoreStaged(),
    error,
    success,
  });
}

router.get('/settings', requireAdmin, (req, res) => {
  renderSettings(req, res, req.query.error || null, req.query.notice || null, req.query.tab);
});

router.post('/settings/username', requireAdmin, requireFullAdmin, (req, res) => {
  const newUsername = (req.body.newUsername || '').trim();

  if (!newUsername) return renderSettings(req, res, 'New username is required.', null, 'account');

  const taken = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?').get(newUsername, req.session.adminId);
  if (taken) return renderSettings(req, res, 'That username is already in use.', null, 'account');

  db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(newUsername, req.session.adminId);
  req.session.username = newUsername;
  renderSettings(req, res, null, 'Username updated.', 'account');
});

router.post('/settings/password', requireAdmin, requireFullAdmin, (req, res) => {
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

// One-click database backup download - see utils/backup.js for how the
// copy itself is made. Full-Admin-only, same as the rest of the Account
// tab: a Co-op Admin (a member, not the master admin account) has no
// business downloading the entire database.
router.get('/settings/backup', requireAdmin, requireFullAdmin, (req, res) => {
  const buffer = backupDatabaseBuffer();
  const stamp = todayISO();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-backup-${stamp}.db"`);
  res.send(buffer);
});

// Uploads a backup file and, once it passes validation (see
// utils/backup.js), stages it to replace the live database on the app's
// next startup - there's no in-app "restart now" button because a bare
// `node server.js` process (this app's typical deployment, see SETUP.md)
// has nothing to restart it if it stopped itself. The staged file only
// takes effect once an admin closes and reopens the app, same as they
// already do to stop/start it day to day.
router.post('/settings/restore', requireAdmin, requireFullAdmin, restoreUpload.single('file'), (req, res) => {
  if (!req.file) {
    return renderSettings(req, res, 'Please choose a .db backup file to restore.', null, 'account');
  }
  try {
    stageRestore(req.file.buffer);
  } catch (err) {
    return renderSettings(req, res, err.message, null, 'account');
  }
  renderSettings(
    req,
    res,
    null,
    'Backup validated and staged. Close and reopen the app to finish restoring - this will replace all current data.',
    'account'
  );
});

router.post('/settings/restore/cancel', requireAdmin, requireFullAdmin, (req, res) => {
  cancelStagedRestore();
  renderSettings(req, res, null, 'Staged restore cancelled. Nothing was changed.', 'account');
});

module.exports = router;
