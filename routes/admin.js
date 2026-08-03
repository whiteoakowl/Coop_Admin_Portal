const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { todayISO, addDays, getOccurrences, getUpcomingOccurrences, formatDateLabel } = require('../utils/dates');

const WEEKS_PER_PAGE = 12;

function buildRosterData(type, day, offset) {
  const today = todayISO();
  // The default page (offset 0) ends on the upcoming/current session so that
  // absences filed in advance for the next session are visible right away.
  const [upcoming] = getUpcomingOccurrences(day, 1, today);
  const anchor = addDays(upcoming, -7 * WEEKS_PER_PAGE * offset);
  const dates = getOccurrences(day, WEEKS_PER_PAGE, anchor);

  const members = db
    .prepare(`SELECT * FROM members WHERE active = 1 AND (days = ? OR days = 'both') ORDER BY name COLLATE NOCASE`)
    .all(day);

  const placeholders = dates.map(() => '?').join(',');

  let cellsByMember = {};
  if (type === 'attendance') {
    const rows = members.length
      ? db
          .prepare(
            `SELECT member_id, session_date, status FROM attendance
             WHERE session_day = ? AND session_date IN (${placeholders})`
          )
          .all(day, ...dates)
      : [];
    for (const r of rows) {
      cellsByMember[r.member_id] = cellsByMember[r.member_id] || {};
      cellsByMember[r.member_id][r.session_date] = r.status === 'present' ? 'P' : 'A';
    }
  } else {
    const rows = members.length
      ? db
          .prepare(
            `SELECT member_id, session_date, number FROM checkouts
             WHERE session_day = ? AND session_date IN (${placeholders})`
          )
          .all(day, ...dates)
      : [];
    for (const r of rows) {
      cellsByMember[r.member_id] = cellsByMember[r.member_id] || {};
      cellsByMember[r.member_id][r.session_date] = String(r.number);
    }
  }

  const rows = members.map((m) => ({
    member: m,
    cells: dates.map((d) => (cellsByMember[m.id] ? cellsByMember[m.id][d] || '' : '')),
  }));

  const canGoNewer = offset > 0;

  return {
    dates,
    dateLabels: dates.map(formatDateLabel),
    rows,
    offset,
    canGoNewer,
  };
}

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

  res.render('admin-dashboard', {
    title: 'Dashboard',
    username: req.session.username,
    memberCount,
    todayPresent,
    todayCheckouts,
    today,
  });
});

// --- Rosters ---

router.get('/roster/:type/:day', requireAdmin, (req, res) => {
  const { type, day } = req.params;
  if (!['attendance', 'checkout'].includes(type) || !['monday', 'wednesday'].includes(day)) {
    return res.status(404).send('Not found');
  }
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const data = buildRosterData(type, day, offset);

  res.render('admin-roster', {
    title: `${day[0].toUpperCase() + day.slice(1)} ${type === 'attendance' ? 'Attendance' : 'Checkout'} Roster`,
    type,
    day,
    ...data,
  });
});

router.get('/roster/:type/:day/export.csv', requireAdmin, (req, res) => {
  const { type, day } = req.params;
  if (!['attendance', 'checkout'].includes(type) || !['monday', 'wednesday'].includes(day)) {
    return res.status(404).send('Not found');
  }
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const data = buildRosterData(type, day, offset);

  const header = ['Name', ...data.dates].join(',');
  const lines = data.rows.map((r) => [`"${r.member.name.replace(/"/g, '""')}"`, ...r.cells].join(','));
  const csv = [header, ...lines].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${day}-${type}-roster.csv"`);
  res.send(csv);
});

// --- Members ---

router.get('/members', requireAdmin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  res.render('admin-members', { title: 'Members', members, error: req.query.error || null });
});

router.post('/members', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const days = ['monday', 'wednesday', 'both'].includes(req.body.days) ? req.body.days : 'both';
  const customBarcode = (req.body.barcode || '').trim();

  if (!name) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Name is required.'));
  }

  if (customBarcode) {
    const exists = db.prepare('SELECT id FROM members WHERE barcode = ?').get(customBarcode);
    if (exists) {
      return res.redirect('/admin/members?error=' + encodeURIComponent('That barcode is already in use.'));
    }
    db.prepare('INSERT INTO members (name, barcode, days) VALUES (?, ?, ?)').run(name, customBarcode, days);
  } else {
    const tempBarcode = `TMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const info = db.prepare('INSERT INTO members (name, barcode, days) VALUES (?, ?, ?)').run(name, tempBarcode, days);
    const barcode = `SH${String(info.lastInsertRowid).padStart(6, '0')}`;
    db.prepare('UPDATE members SET barcode = ? WHERE id = ?').run(barcode, info.lastInsertRowid);
  }

  res.redirect('/admin/members');
});

router.post('/members/:id/edit', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const days = ['monday', 'wednesday', 'both'].includes(req.body.days) ? req.body.days : 'both';
  if (!name) return res.redirect('/admin/members?error=' + encodeURIComponent('Name is required.'));
  db.prepare('UPDATE members SET name = ?, days = ? WHERE id = ?').run(name, days, id);
  res.redirect('/admin/members');
});

router.post('/members/:id/toggle-active', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (member) {
    db.prepare('UPDATE members SET active = ? WHERE id = ?').run(member.active ? 0 : 1, id);
  }
  res.redirect('/admin/members');
});

router.get('/members/:id/badge', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  res.render('admin-badge', { title: `Badge - ${member.name}`, member, layout: false });
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
