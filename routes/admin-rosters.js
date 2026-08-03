const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { todayISO, addDays, getOccurrences, getUpcomingOccurrences, formatDateLabel, formatTime } = require('../utils/dates');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const WEEKS_PER_PAGE = 12;

function rosterMembers(rosterId) {
  return db
    .prepare(
      `SELECT m.* FROM members m
       JOIN roster_members rm ON rm.member_id = m.id
       WHERE rm.roster_id = ? AND m.active = 1
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(rosterId);
}

function buildRosterGridData(roster, offset) {
  const today = todayISO();
  const [upcoming] = getUpcomingOccurrences(roster.day, 1, today);
  const anchor = addDays(upcoming, -7 * WEEKS_PER_PAGE * offset);
  const dates = getOccurrences(roster.day, WEEKS_PER_PAGE, anchor);
  const placeholders = dates.map(() => '?').join(',');

  const members = rosterMembers(roster.id);

  const attendanceRows = members.length
    ? db
        .prepare(
          `SELECT member_id, session_date, status, check_in_time FROM attendance
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];
  const checkoutRows = members.length
    ? db
        .prepare(
          `SELECT member_id, session_date, number, check_out_time FROM checkouts
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];

  const attendanceByKey = {};
  for (const r of attendanceRows) attendanceByKey[`${r.member_id}|${r.session_date}`] = r;
  const checkoutByKey = {};
  for (const r of checkoutRows) checkoutByKey[`${r.member_id}|${r.session_date}`] = r;

  const rows = members.map((m) => ({
    member: m,
    cells: dates.map((d) => {
      const att = attendanceByKey[`${m.id}|${d}`];
      const out = checkoutByKey[`${m.id}|${d}`];
      if (!att) return null;
      const tag = att.status === 'present' ? 'P' : att.status === 'late' ? 'L' : 'A';
      return {
        tag,
        checkInTime: formatTime(att.check_in_time),
        checkOutTime: out ? formatTime(out.check_out_time) : null,
        number: out ? out.number : null,
      };
    }),
  }));

  return {
    dates,
    dateLabels: dates.map(formatDateLabel),
    rows,
    offset,
    canGoNewer: offset > 0,
  };
}

// --- Roster list & creation ---

router.get('/rosters', requireAdmin, (req, res) => {
  const rosters = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM roster_members rm WHERE rm.roster_id = r.id) AS memberCount
       FROM rosters r ORDER BY r.active DESC, r.day, r.name COLLATE NOCASE`
    )
    .all();
  res.render('admin-rosters', { title: 'Rosters', rosters, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/rosters', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const day = ['monday', 'wednesday'].includes(req.body.day) ? req.body.day : null;
  if (!name || !day) {
    return res.redirect('/admin/rosters?error=' + encodeURIComponent('Name and day are required.'));
  }
  const info = db.prepare('INSERT INTO rosters (name, day) VALUES (?, ?)').run(name, day);
  res.redirect(`/admin/rosters/${info.lastInsertRowid}/manage`);
});

router.post('/rosters/:id/toggle-active', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  if (roster) db.prepare('UPDATE rosters SET active = ? WHERE id = ?').run(roster.active ? 0 : 1, id);
  res.redirect('/admin/rosters');
});

router.post('/rosters/:id/rename', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const day = ['monday', 'wednesday'].includes(req.body.day) ? req.body.day : null;
  if (!name || !day) {
    return res.redirect('/admin/rosters?error=' + encodeURIComponent('Name and day are required.'));
  }
  db.prepare('UPDATE rosters SET name = ?, day = ? WHERE id = ?').run(name, day, id);
  res.redirect('/admin/rosters');
});

// --- Roster membership management ---

router.get('/rosters/:id/manage', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  if (!roster) return res.status(404).send('Not found');

  const members = rosterMembers(id);
  const memberIds = members.map((m) => m.id);
  const availableMembers = db
    .prepare('SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all()
    .filter((m) => !memberIds.includes(m.id));

  res.render('admin-roster-manage', {
    title: `Manage ${roster.name}`,
    roster,
    members,
    availableMembers,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/rosters/:id/add-member', requireAdmin, (req, res) => {
  const rosterId = parseInt(req.params.id, 10);
  const memberId = parseInt(req.body.memberId, 10);
  if (memberId) {
    db.prepare('INSERT OR IGNORE INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  }
  res.redirect(`/admin/rosters/${rosterId}/manage`);
});

router.post('/rosters/:id/remove-member/:memberId', requireAdmin, (req, res) => {
  const rosterId = parseInt(req.params.id, 10);
  const memberId = parseInt(req.params.memberId, 10);
  db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(rosterId, memberId);
  res.redirect(`/admin/rosters/${rosterId}/manage`);
});

// --- Bulk import (names-only file, one name per line) ---

router.post('/rosters/:id/import', requireAdmin, upload.single('file'), (req, res) => {
  const rosterId = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  if (!roster) return res.status(404).send('Not found');

  if (!req.file) {
    return res.redirect(`/admin/rosters/${rosterId}/manage?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  const text = req.file.buffer.toString('utf8');
  const names = text
    .split(/\r?\n/)
    .map((line) => line.split(',')[0].trim().replace(/^"|"$/g, ''))
    .filter((name) => name && name.toLowerCase() !== 'name');

  let created = 0;
  let linked = 0;

  const findMember = db.prepare('SELECT * FROM members WHERE active = 1 AND name = ? COLLATE NOCASE');
  const insertMember = db.prepare(`INSERT INTO members (name, barcode) VALUES (?, ?)`);
  const updateBarcode = db.prepare('UPDATE members SET barcode = ? WHERE id = ?');
  const linkMember = db.prepare('INSERT OR IGNORE INTO roster_members (roster_id, member_id) VALUES (?, ?)');

  for (const name of names) {
    let member = findMember.get(name);
    if (!member) {
      const tempBarcode = `TMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const info = insertMember.run(name, tempBarcode);
      const barcode = `SH${String(info.lastInsertRowid).padStart(6, '0')}`;
      updateBarcode.run(barcode, info.lastInsertRowid);
      member = { id: info.lastInsertRowid };
      created++;
    }
    const result = linkMember.run(rosterId, member.id);
    if (result.changes > 0) linked++;
  }

  res.redirect(
    `/admin/rosters/${rosterId}/manage?notice=` +
      encodeURIComponent(`Imported ${names.length} name(s): ${created} new member(s) created, ${linked} added to this roster.`)
  );
});

// --- Combined roster grid + export ---

router.get('/roster/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  if (!roster) return res.status(404).send('Not found');

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const data = buildRosterGridData(roster, offset);

  res.render('admin-roster', {
    title: `${roster.name} Roster`,
    roster,
    ...data,
  });
});

router.get('/roster/:id/export.csv', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  if (!roster) return res.status(404).send('Not found');

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const data = buildRosterGridData(roster, offset);

  const header = ['Name'];
  for (const d of data.dates) {
    header.push(`${d} Status`, `${d} Check-In`, `${d} Check-Out`, `${d} #`);
  }

  const lines = data.rows.map((r) => {
    const row = [`"${r.member.name.replace(/"/g, '""')}"`];
    for (const cell of r.cells) {
      row.push(cell ? cell.tag : '', cell?.checkInTime || '', cell?.checkOutTime || '', cell?.number ?? '');
    }
    return row.join(',');
  });

  const csv = [header.join(','), ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${roster.name.replace(/[^a-z0-9]+/gi, '-')}-roster.csv"`);
  res.send(csv);
});

module.exports = router;
