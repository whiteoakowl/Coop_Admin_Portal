const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatTime } = require('../utils/dates');
const { parseNamesFile, findOrCreateMemberByName } = require('../utils/members');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

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

function rosterDates(rosterId) {
  return db
    .prepare('SELECT session_date FROM roster_dates WHERE roster_id = ? ORDER BY session_date ASC')
    .all(rosterId)
    .map((r) => r.session_date);
}

function distinctCategories() {
  return db
    .prepare(`SELECT DISTINCT category FROM rosters WHERE category IS NOT NULL AND category != '' ORDER BY category COLLATE NOCASE`)
    .all()
    .map((r) => r.category);
}

function importNamesIntoRoster(rosterId, buffer) {
  const names = parseNamesFile(buffer);
  const linkMember = db.prepare('INSERT OR IGNORE INTO roster_members (roster_id, member_id) VALUES (?, ?)');

  let created = 0;
  let linked = 0;
  for (const name of names) {
    const { member, created: wasCreated } = findOrCreateMemberByName(name);
    if (wasCreated) created++;
    const result = linkMember.run(rosterId, member.id);
    if (result.changes > 0) linked++;
  }
  return { total: names.length, created, linked };
}

function buildRosterGridData(roster) {
  const dates = rosterDates(roster.id);
  const placeholders = dates.map(() => '?').join(',');
  const members = rosterMembers(roster.id);

  const attendanceRows = members.length && dates.length
    ? db
        .prepare(
          `SELECT member_id, session_date, status, check_in_time FROM attendance
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];
  const checkoutRows = members.length && dates.length
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

  const summary = dates.map((d, i) => {
    let present = 0, late = 0, absent = 0;
    for (const row of rows) {
      const cell = row.cells[i];
      if (!cell) continue;
      if (cell.tag === 'P') present++;
      else if (cell.tag === 'L') late++;
      else if (cell.tag === 'A') absent++;
    }
    return { present, late, absent };
  });

  return {
    dates,
    dateLabels: dates.map(formatDateLabel),
    rows,
    summary,
  };
}

// --- Roster list & creation ---

router.get('/rosters', requireAdmin, (req, res) => {
  const category = (req.query.category || '').trim();
  let sql = `SELECT r.*, (SELECT COUNT(*) FROM roster_members rm WHERE rm.roster_id = r.id) AS memberCount,
             (SELECT COUNT(*) FROM roster_dates rd WHERE rd.roster_id = r.id) AS dateCount
             FROM rosters r`;
  const params = [];
  if (category) {
    sql += ' WHERE r.category = ?';
    params.push(category);
  }
  sql += ' ORDER BY r.active DESC, r.name COLLATE NOCASE';
  const rosters = db.prepare(sql).all(...params);

  res.render('admin-rosters', {
    title: 'Rosters',
    rosters,
    categories: distinctCategories(),
    selectedCategory: category,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/rosters', requireAdmin, upload.single('file'), (req, res) => {
  const name = (req.body.name || '').trim();
  const category = (req.body.category || '').trim() || null;
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))].sort();

  if (!name) {
    return res.redirect('/admin/rosters?error=' + encodeURIComponent('Roster title is required.'));
  }
  if (dates.length === 0) {
    return res.redirect('/admin/rosters?error=' + encodeURIComponent('Pick at least one date for the roster.'));
  }

  const info = db.prepare('INSERT INTO rosters (name, category) VALUES (?, ?)').run(name, category);
  const rosterId = info.lastInsertRowid;

  const insertDate = db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)');
  for (const d of dates) insertDate.run(rosterId, d);

  let notice = `Roster "${name}" created with ${dates.length} date${dates.length === 1 ? '' : 's'}.`;
  if (req.file) {
    const result = importNamesIntoRoster(rosterId, req.file.buffer);
    notice += ` Imported ${result.total} name(s): ${result.created} new member(s), ${result.linked} added to the roster.`;
  }

  res.redirect(`/admin/rosters/${rosterId}/manage?notice=` + encodeURIComponent(notice));
});

router.post('/rosters/:id/rename', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const category = (req.body.category || '').trim() || null;
  if (!name) {
    return res.redirect(`/admin/rosters/${id}/manage?error=` + encodeURIComponent('Roster title is required.'));
  }
  db.prepare('UPDATE rosters SET name = ?, category = ? WHERE id = ?').run(name, category, id);
  res.redirect(`/admin/rosters/${id}/manage`);
});

router.post('/rosters/:id/toggle-active', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  if (roster) db.prepare('UPDATE rosters SET active = ? WHERE id = ?').run(roster.active ? 0 : 1, id);
  res.redirect('/admin/rosters');
});

router.post('/rosters/:id/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  db.prepare('DELETE FROM rosters WHERE id = ?').run(id);
  res.redirect(
    '/admin/rosters?notice=' + encodeURIComponent(roster ? `Deleted "${roster.name}" and its attendance history.` : 'Roster deleted.')
  );
});

// --- Roster dates management ---

router.post('/rosters/:id/dates/add', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)');
  for (const d of dates) insertDate.run(id, d);
  res.redirect(`/admin/rosters/${id}/manage?notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/rosters/:id/dates/:date/remove', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const date = req.params.date;
  db.prepare('DELETE FROM roster_dates WHERE roster_id = ? AND session_date = ?').run(id, date);
  db.prepare('DELETE FROM attendance WHERE roster_id = ? AND session_date = ?').run(id, date);
  db.prepare('DELETE FROM checkouts WHERE roster_id = ? AND session_date = ?').run(id, date);
  res.redirect(`/admin/rosters/${id}/manage?notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)} and its attendance records.`));
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

  const dates = rosterDates(id);

  res.render('admin-roster-manage', {
    title: `Manage ${roster.name}`,
    roster,
    members,
    availableMembers,
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    categories: distinctCategories(),
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

// --- Bulk import (names-only file, one name per line) into an existing roster ---

router.post('/rosters/:id/import', requireAdmin, upload.single('file'), (req, res) => {
  const rosterId = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId);
  if (!roster) return res.status(404).send('Not found');

  if (!req.file) {
    return res.redirect(`/admin/rosters/${rosterId}/manage?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  const result = importNamesIntoRoster(rosterId, req.file.buffer);
  res.redirect(
    `/admin/rosters/${rosterId}/manage?notice=` +
      encodeURIComponent(`Imported ${result.total} name(s): ${result.created} new member(s) created, ${result.linked} added to this roster.`)
  );
});

// --- Combined roster grid + export ---

router.get('/roster/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = db.prepare('SELECT * FROM rosters WHERE id = ?').get(id);
  if (!roster) return res.status(404).send('Not found');

  const data = buildRosterGridData(roster);

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

  const data = buildRosterGridData(roster);

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

  const summaryRows = ['Present', 'Late', 'Absent'].map((label, idx) => {
    const key = label.toLowerCase();
    const row = [label];
    for (const s of data.summary) {
      row.push(key === 'present' ? s.present : key === 'late' ? s.late : s.absent, '', '', '');
    }
    return row.join(',');
  });

  const csv = [header.join(','), ...lines, ...summaryRows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${roster.name.replace(/[^a-z0-9]+/gi, '-')}-roster.csv"`);
  res.send(csv);
});

module.exports = router;
