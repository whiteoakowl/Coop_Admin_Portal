// Sections - a real request: group members into named sections (e.g.
// "Teen Co-op", "Homeschool Group A") independent of Family, so Events
// and Classes can each optionally restrict who can see/register for
// them to specific sections (see supabase/migrations/
// 20260826010000_sections.sql). Sibling router at /main-admin/sections,
// gated by manage_sections - same "native to Main Admin" pattern as
// routes/main-admin-members.js and routes/main-admin-announcements.js.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { activeMemberOptions, byLastName } = require('../utils/members');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_sections'));

async function sectionsWithCounts() {
  return db
    .prepare(
      `SELECT s.*, COUNT(ms.member_id) AS "memberCount"
       FROM sections s LEFT JOIN member_sections ms ON ms.section_id = s.id
       GROUP BY s.id ORDER BY LOWER(s.name)`
    )
    .all();
}

router.get('/', async (req, res) => {
  res.render('main-admin-sections', {
    title: 'Sections',
    sections: await sectionsWithCounts(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/new', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/sections?error=' + encodeURIComponent('Section name is required.'));
  const exists = await db.prepare('SELECT 1 FROM sections WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) return res.redirect('/main-admin/sections?error=' + encodeURIComponent(`"${name}" already exists.`));
  await db.prepare('INSERT INTO sections (name, description) VALUES (?, ?)').run(name, (req.body.description || '').trim() || null);
  res.redirect('/main-admin/sections?notice=' + encodeURIComponent(`"${name}" created.`));
});

router.post('/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/sections?error=' + encodeURIComponent('Section name is required.'));
  const clash = await db.prepare('SELECT 1 FROM sections WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (clash) return res.redirect('/main-admin/sections?error=' + encodeURIComponent(`"${name}" already exists.`));
  await db.prepare('UPDATE sections SET name = ?, description = ? WHERE id = ?').run(name, (req.body.description || '').trim() || null, id);
  res.redirect('/main-admin/sections?notice=' + encodeURIComponent('Section updated.'));
});

router.post('/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const section = await db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
  await db.prepare('DELETE FROM sections WHERE id = ?').run(id);
  res.redirect('/main-admin/sections?notice=' + encodeURIComponent(section ? `Deleted "${section.name}".` : 'Section deleted.'));
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const section = await db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
  if (!section) return res.status(404).send('Not found');

  const members = (
    await db
      .prepare(`SELECT m.* FROM members m JOIN member_sections ms ON ms.member_id = m.id WHERE ms.section_id = ? AND m.active = 1`)
      .all(id)
  ).sort(byLastName);
  const memberIds = new Set(members.map((m) => m.id));
  const available = (await activeMemberOptions()).filter((m) => !memberIds.has(m.id));

  res.render('main-admin-section-detail', {
    title: section.name,
    section,
    members,
    available,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:id/members/add', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const memberId = parseInt(req.body.memberId, 10);
  if (memberId) {
    await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(memberId, id);
  }
  res.redirect(`/main-admin/sections/${id}`);
});

router.post('/:id/members/:memberId/remove', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('DELETE FROM member_sections WHERE section_id = ? AND member_id = ?').run(id, parseInt(req.params.memberId, 10));
  res.redirect(`/main-admin/sections/${id}`);
});

module.exports = router;
