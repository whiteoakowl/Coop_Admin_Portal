const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { todayISO, formatDateLabel } = require('../utils/dates');
const { buildTemplateWorkbook } = require('../utils/spreadsheet');
const { todaysAlerts } = require('../utils/alerts');
const { isRateLimited, recordFailure, recordSuccess } = require('../utils/loginRateLimit');
const { setClassCheckinPin } = require('../utils/classCheckinPin');
const { computeTrend } = require('../utils/dashboardTrends');

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

router.post('/login', async (req, res) => {
  const next = safeNext(req.body.next);
  if (isRateLimited(req.ip)) {
    return res.render('admin-login', {
      title: 'Admin Login',
      error: 'Too many login attempts. Please wait a few minutes and try again.',
      next,
    });
  }

  const { username, password } = req.body;
  // Case-insensitive on purpose - there's only ever one admin account
  // (or a small handful, all trusted), so nothing depends on "Admin" and
  // "admin" being different logins, and a mismatched case (e.g. a mobile
  // keyboard auto-capitalizing the first letter) shouldn't be able to
  // lock someone out who's typing the right username.
  const admin = await db.prepare('SELECT * FROM admins WHERE LOWER(username) = LOWER(?)').get((username || '').trim());
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
//
// Every query here excludes rosters.category = 'Class Roster' - a member
// showing up as present, late, absent, or checked out of one specific
// CLASS (routes/kiosk-class-checkin.js) doesn't mean they showed up at
// the co-op at all today; only their day-level Parent/Student roster
// reflects that. Without this filter, checking into or out of a single
// class would inflate this whole-day dashboard the same as actually
// checking in/out at the front door - the exact "two independent
// presence signals" isolation the class check-in flow was built to keep
// (see routes/kiosk.js's own comment), just extended to this aggregate.
async function todayStatsForType(memberType, today) {
  const total = (
    await db.prepare(`SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = ?`).get(memberType)
  ).c;
  const checkedIn = (
    await db
      .prepare(
        `SELECT COUNT(DISTINCT a.member_id) AS c FROM attendance a
         JOIN members m ON m.id = a.member_id
         JOIN rosters r ON r.id = a.roster_id
         WHERE a.session_date = ? AND a.status = 'present' AND m.member_type = ? AND r.category != 'Class Roster'`
      )
      .get(today, memberType)
  ).c;
  const checkedOut = (
    await db
      .prepare(
        `SELECT COUNT(DISTINCT c.member_id) AS c FROM checkouts c
         JOIN members m ON m.id = c.member_id
         JOIN rosters r ON r.id = c.roster_id
         WHERE c.session_date = ? AND m.member_type = ? AND r.category != 'Class Roster'`
      )
      .get(today, memberType)
  ).c;
  const late = (
    await db
      .prepare(
        `SELECT COUNT(DISTINCT a.member_id) AS c FROM attendance a
         JOIN members m ON m.id = a.member_id
         JOIN rosters r ON r.id = a.roster_id
         WHERE a.session_date = ? AND a.status = 'late' AND m.member_type = ? AND r.category != 'Class Roster'`
      )
      .get(today, memberType)
  ).c;
  const absent = (
    await db
      .prepare(
        `SELECT COUNT(DISTINCT a.member_id) AS c FROM attendance a
         JOIN members m ON m.id = a.member_id
         JOIN rosters r ON r.id = a.roster_id
         WHERE a.session_date = ? AND a.status = 'absent' AND m.member_type = ? AND r.category != 'Class Roster'`
      )
      .get(today, memberType)
  ).c;

  return { total, checkedIn, checkedOut, late, absent };
}

// The most recent day-level (non-class-roster) session date with any
// recorded attendance strictly before `today` - i.e. "last time this ran",
// whichever weekday that happened to be. Excludes class rosters for the
// same reason todayStatsForType() does: a day where a class was checked
// into but the day-level roster never ran isn't a real prior session to
// trend against.
async function previousSessionDate(today) {
  const row = await db
    .prepare(
      `SELECT DISTINCT a.session_date FROM attendance a
       JOIN rosters r ON r.id = a.roster_id
       WHERE a.session_date < ? AND r.category != 'Class Roster'
       ORDER BY a.session_date DESC LIMIT 1`
    )
    .get(today);
  return row ? row.session_date : null;
}

// Attaches a trends object (see utils/dashboardTrends.js) to a
// todayStatsForType() result, comparing each of the four counts against
// the same stat from the previous session - null (no trends rendered at
// all) when there isn't a previous session yet, rather than a misleading
// comparison against a session that never happened.
async function statsWithTrends(memberType, today, previousDate) {
  const current = await todayStatsForType(memberType, today);
  if (!previousDate) return { ...current, trends: null, previousDateLabel: null };
  const previous = await todayStatsForType(memberType, previousDate);
  return {
    ...current,
    trends: {
      checkedIn: computeTrend(current.checkedIn, previous.checkedIn),
      checkedOut: computeTrend(current.checkedOut, previous.checkedOut),
      absent: computeTrend(current.absent, previous.absent),
      late: computeTrend(current.late, previous.late),
    },
    previousDateLabel: formatDateLabel(previousDate),
  };
}

router.get('/', requireAdmin, async (req, res) => {
  const today = todayISO();
  const previousDate = await previousSessionDate(today);
  const memberCount = (await db.prepare('SELECT COUNT(*) AS c FROM members WHERE active = 1').get()).c;
  const studentCount = (await db.prepare("SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = 'student'").get()).c;
  const parentCount = (await db.prepare("SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = 'parent'").get()).c;
  const familyCount = (await db.prepare('SELECT COUNT(*) AS c FROM families').get()).c;

  res.render('admin-dashboard', {
    title: 'Dashboard',
    memberCount,
    studentCount,
    parentCount,
    familyCount,
    studentStats: await statsWithTrends('student', today, previousDate),
    parentStats: await statsWithTrends('parent', today, previousDate),
    alerts: await todaysAlerts(),
  });
});

// Shared "names only" import template for Rosters, Floater Assignments, and
// Absence/Late - those pages only ever link an existing Members-page
// profile by name, never create one.
router.get('/import-template/names.xlsx', requireAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(['First Name', 'Last Name'], [['Alice', 'Smith'], ['Bob', 'Jones']]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import-names-template.xlsx"');
  res.send(buffer);
});

// --- Settings ---

const SETTINGS_TABS = ['account', 'classcheckin', 'quicklinks', 'install', 'documents'];
const FULL_ADMIN_ONLY_TABS = ['account', 'classcheckin', 'documents'];

async function renderSettings(req, res, error, success, activeTab) {
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
    documents: await db.prepare('SELECT * FROM documents ORDER BY LOWER(title)').all(),
    error,
    success,
  });
}

router.get('/settings', requireAdmin, async (req, res) => {
  await renderSettings(req, res, req.query.error || null, req.query.notice || null, req.query.tab);
});

router.post('/settings/username', requireAdmin, requireFullAdmin, async (req, res) => {
  const newUsername = (req.body.newUsername || '').trim();

  if (!newUsername) return renderSettings(req, res, 'New username is required.', null, 'account');

  // Case-insensitive, matching the login lookup above - otherwise two
  // accounts could end up differing only by case, which login could never
  // tell apart anyway.
  const taken = await db.prepare('SELECT id FROM admins WHERE LOWER(username) = LOWER(?) AND id != ?').get(newUsername, req.session.adminId);
  if (taken) return renderSettings(req, res, 'That username is already in use.', null, 'account');

  await db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(newUsername, req.session.adminId);
  req.session.username = newUsername;
  await renderSettings(req, res, null, 'Username updated.', 'account');
});

router.post('/settings/password', requireAdmin, requireFullAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = await db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);

  if (!admin || !bcrypt.compareSync(currentPassword || '', admin.password_hash)) {
    return renderSettings(req, res, 'Current password is incorrect.', null, 'account');
  }
  if (!newPassword || newPassword.length < 8) {
    return renderSettings(req, res, 'New password must be at least 8 characters.', null, 'account');
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  await renderSettings(req, res, null, 'Password updated.', 'account');
});

// Backup/Restore (routes/settings/backup, /settings/restore,
// /settings/restore/cancel) were removed here - they were built entirely
// around SQLite-specific mechanics (VACUUM INTO, opening a candidate file
// as a throwaway SQLite connection to validate it) that have no Postgres
// equivalent, now that the app's data lives in Supabase (see
// MIGRATION.md and utils/backup.js's own header comment). Supabase backs
// up data on its own end; a Postgres-native replacement for this feature
// is a real, separate future project, not a routine conversion.

// One shared 4-digit PIN for the kiosk's Class Check-In flow (routes/
// kiosk-class-checkin.js) - not tied to any admin account, same as
// there's exactly one admin login rather than per-admin ones. Stored
// hashed in app_settings (utils/classSchedule.js's appSetting/
// setAppSetting), seeded with a default on first boot (db/index.js).
// No "current PIN" confirmation required to change it, unlike the admin
// password above - reaching this form at all already requires being
// logged in as full Admin, and the PIN itself is a lower-stakes secondary
// check (kiosk class check-in access), not the credential that gates
// everything else the way the admin password does.
router.post('/settings/class-checkin-pin', requireAdmin, requireFullAdmin, async (req, res) => {
  const newPin = (req.body.newPin || '').trim();
  if (!/^\d{4}$/.test(newPin)) {
    return renderSettings(req, res, 'PIN must be exactly 4 digits.', null, 'classcheckin');
  }
  await setClassCheckinPin(newPin);
  await renderSettings(req, res, null, 'Class Check-In PIN updated.', 'classcheckin');
});

module.exports = router;
