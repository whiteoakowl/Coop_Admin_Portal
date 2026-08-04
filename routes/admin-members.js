const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { parseNamesFile, findOrCreateMemberByName } = require('../utils/members');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// Both the Members page and the Absence/Late page post to these same
// routes; this sends the admin back to whichever page they came from.
function safeReturnTo(req) {
  const r = req.body.returnTo;
  return r && r.startsWith('/admin/') ? r : '/admin/members';
}

function rostersForMember(memberId) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? ORDER BY r.name COLLATE NOCASE`
    )
    .all(memberId);
}

router.get('/members', requireAdmin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  const withRosters = members.map((m) => ({ ...m, rosters: rostersForMember(m.id) }));
  res.render('admin-members', {
    title: 'Members',
    members: withRosters,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/absence-list', requireAdmin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  res.render('admin-absence-list', {
    title: 'Absence/Late List',
    members,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/members', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const customBarcode = (req.body.barcode || '').trim();
  const rosterIds = [].concat(req.body.rosterIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const returnTo = safeReturnTo(req);

  if (!name) {
    return res.redirect(returnTo + '?error=' + encodeURIComponent('Name is required.'));
  }

  // Barcodes read as names, so default the barcode to the member's name.
  const barcode = customBarcode || name;
  const exists = db.prepare('SELECT id FROM members WHERE barcode = ?').get(barcode);
  if (exists) {
    const msg = customBarcode ? 'That barcode is already in use.' : `"${barcode}" is already in the member list.`;
    return res.redirect(returnTo + '?error=' + encodeURIComponent(msg));
  }

  const info = db.prepare('INSERT INTO members (name, barcode) VALUES (?, ?)').run(name, barcode);
  const memberId = info.lastInsertRowid;

  const linkMember = db.prepare('INSERT OR IGNORE INTO roster_members (roster_id, member_id) VALUES (?, ?)');
  for (const rosterId of rosterIds) linkMember.run(rosterId, memberId);

  res.redirect(returnTo);
});

// Names-only bulk import, not tied to any roster - populates the shared
// member list (and therefore the Absence/Late form's name dropdown).
router.post('/members/import', requireAdmin, upload.single('file'), (req, res) => {
  const returnTo = safeReturnTo(req);
  if (!req.file) {
    return res.redirect(returnTo + '?error=' + encodeURIComponent('Please choose a file to import.'));
  }
  const names = parseNamesFile(req.file.buffer);
  let created = 0;
  for (const name of names) {
    const { created: wasCreated } = findOrCreateMemberByName(name);
    if (wasCreated) created++;
  }
  res.redirect(returnTo + '?notice=' + encodeURIComponent(`Imported ${names.length} name(s): ${created} new member(s) created.`));
});

router.post('/members/:id/edit', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const returnTo = safeReturnTo(req);
  if (!name) return res.redirect(returnTo + '?error=' + encodeURIComponent('Name is required.'));
  db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, id);
  res.redirect(returnTo);
});

router.post('/members/:id/toggle-active', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (member) {
    db.prepare('UPDATE members SET active = ? WHERE id = ?').run(member.active ? 0 : 1, id);
  }
  res.redirect(safeReturnTo(req));
});

router.get('/members/:id/badge', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  res.render('admin-badge', { title: `Badge - ${member.name}`, member, layout: false });
});

module.exports = router;
