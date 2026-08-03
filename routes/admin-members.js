const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');

function rostersForMember(memberId) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? ORDER BY r.day, r.name COLLATE NOCASE`
    )
    .all(memberId);
}

router.get('/members', requireAdmin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  const withRosters = members.map((m) => ({ ...m, rosters: rostersForMember(m.id) }));
  const allRosters = db.prepare('SELECT * FROM rosters WHERE active = 1 ORDER BY day, name COLLATE NOCASE').all();
  res.render('admin-members', { title: 'Members', members: withRosters, allRosters, error: req.query.error || null });
});

router.post('/members', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const customBarcode = (req.body.barcode || '').trim();
  const rosterIds = [].concat(req.body.rosterIds || []).map((id) => parseInt(id, 10)).filter(Boolean);

  if (!name) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Name is required.'));
  }

  let memberId;
  if (customBarcode) {
    const exists = db.prepare('SELECT id FROM members WHERE barcode = ?').get(customBarcode);
    if (exists) {
      return res.redirect('/admin/members?error=' + encodeURIComponent('That barcode is already in use.'));
    }
    const info = db.prepare('INSERT INTO members (name, barcode) VALUES (?, ?)').run(name, customBarcode);
    memberId = info.lastInsertRowid;
  } else {
    const tempBarcode = `TMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const info = db.prepare('INSERT INTO members (name, barcode) VALUES (?, ?)').run(name, tempBarcode);
    const barcode = `SH${String(info.lastInsertRowid).padStart(6, '0')}`;
    db.prepare('UPDATE members SET barcode = ? WHERE id = ?').run(barcode, info.lastInsertRowid);
    memberId = info.lastInsertRowid;
  }

  const linkMember = db.prepare('INSERT OR IGNORE INTO roster_members (roster_id, member_id) VALUES (?, ?)');
  for (const rosterId of rosterIds) linkMember.run(rosterId, memberId);

  res.redirect('/admin/members');
});

router.post('/members/:id/edit', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/members?error=' + encodeURIComponent('Name is required.'));
  db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, id);
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

module.exports = router;
