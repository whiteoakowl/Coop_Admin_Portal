// Member/family roster management, natively inside the Main Admin Portal
// - a real request: "member list ... should be manageable on main admin
// portal", not just linked out to the Co-op Admin Portal's existing
// /admin/members (a separate login, routes/admin-members.js, entirely
// unaffected by this file). Deliberately reuses the exact same data-layer
// helpers that page already uses (utils/members.js, utils/pagination.js,
// utils/dates.js, utils/classSchedule.js's GRADE_LEVELS) so member-record
// correctness (family grouping, primary-parent uniqueness, member-code
// generation, active/archived filtering) can't drift between the two -
// only the route wiring, auth gate, and view are new.
//
// Scoped down from /admin/members's full feature set on purpose: no photo
// upload, CSV export, Excel bulk import, bulk-select actions, or
// printable name-tag/schedule-card generation here - those stay print/
// file-heavy legacy-portal-only features. This still covers every core
// "manage the roster" action: add, edit every profile field, family
// grouping (including creating a family inline), archive, and delete.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { formatDateLabel, formatDateNumeric, ageFromBirthday } = require('../utils/dates');
const { GRADE_LEVELS } = require('../utils/classSchedule');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { createStorageClient } = require('../utils/storage');
const { removeUpload } = require('../utils/uploadBackend');
const path = require('path');
const {
  familyOf,
  allFamilies,
  setMemberFamily,
  setPrimaryParent,
  rostersForMember,
  membersWithDetails,
  generateMemberCode,
  byLastName,
} = require('../utils/members');
const { getMemberSchedule } = require('../utils/schedule');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_members'));

const MEMBER_TYPES = ['student', 'parent', 'admin'];
const MEMBER_PHOTOS_BUCKET = 'member-photos';
const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'members');
const storageClient = createStorageClient();

// Only used here to clean up an existing photo on delete (see
// deleteMemberById below) - this file never writes a new one, so there's
// no matching savePhotoFile/multer setup, just the removal half.
function deletePhotoFile(photoPath) {
  return removeUpload({ client: storageClient, bucket: MEMBER_PHOTOS_BUCKET, localDir: PHOTO_DIR, key: photoPath });
}

async function attendanceHistoryForMember(memberId) {
  return db
    .prepare(
      `SELECT r.name AS "rosterName", a.session_date AS date, a.status,
              a.check_in_time AS "checkInTime", c.check_out_time AS "checkOutTime"
       FROM attendance a
       JOIN rosters r ON r.id = a.roster_id
       LEFT JOIN checkouts c ON c.member_id = a.member_id AND c.roster_id = a.roster_id AND c.session_date = a.session_date
       WHERE a.member_id = ?
       ORDER BY a.session_date DESC
       LIMIT 25`
    )
    .all(memberId);
}

// --- List ---

router.get('/', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const showArchived = req.query.archived === '1';
  const q = (req.query.q || '').trim().toLowerCase();

  let withRosters = (await membersWithDetails(typeFilter, familyFilter))
    .filter((m) => (showArchived ? Number(m.active) === 0 : Number(m.active) === 1))
    .map((m) => ({ ...m, age: ageFromBirthday(m.birthday), birthdayLabel: m.birthday ? formatDateNumeric(m.birthday) : null }));
  if (q) withRosters = withRosters.filter((m) => m.name.toLowerCase().includes(q));

  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(withRosters, parsePage(req.query.page), pageSize);

  res.render('main-admin-members', {
    title: 'Members',
    members: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref:
      '/main-admin/members?' +
      (typeFilter ? `type=${typeFilter}&` : '') +
      (familyFilter ? `family=${familyFilter}&` : '') +
      (showArchived ? `archived=1&` : '') +
      (q ? `q=${encodeURIComponent(q)}&` : ''),
    typeFilter,
    familyFilter,
    showArchived,
    q: req.query.q || '',
    families: await allFamilies(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Families (add/rename/delete the family "name" itself - see
// families.name's own uniqueness constraint and members.family_id's ON
// DELETE SET NULL, so deleting a family here only ungroups its members,
// never deletes the members themselves). ---

router.post('/families/new', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/members?error=' + encodeURIComponent('Family name is required.'));
  const exists = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) return res.redirect('/main-admin/members?error=' + encodeURIComponent(`"${name}" family already exists.`));
  await db.prepare('INSERT INTO families (name) VALUES (?)').run(name);
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`"${name}" family added.`));
});

router.post('/families/:id/rename', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/members?error=' + encodeURIComponent('Family name is required.'));
  const clash = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (clash) return res.redirect('/main-admin/members?error=' + encodeURIComponent(`"${name}" family already exists.`));
  await db.prepare('UPDATE families SET name = ? WHERE id = ?').run(name, id);
  res.redirect('/main-admin/members?notice=' + encodeURIComponent('Family renamed.'));
});

router.post('/families/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const family = await db.prepare('SELECT * FROM families WHERE id = ?').get(id);
  await db.prepare('DELETE FROM families WHERE id = ?').run(id);
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(family ? `Deleted "${family.name}" family.` : 'Family deleted.'));
});

// --- Add / edit ---

function memberFormFields(req) {
  const memberType = MEMBER_TYPES.includes(req.body.memberType) ? req.body.memberType : 'student';
  const newFamilyName = (req.body.newFamilyName || '').trim();
  const familyIdRaw = parseInt(req.body.familyId, 10);
  return {
    name: (req.body.name || '').trim(),
    memberType,
    address: (req.body.address || '').trim() || null,
    city: (req.body.city || '').trim() || null,
    state: (req.body.state || '').trim() || null,
    zip: (req.body.zip || '').trim() || null,
    phone: (req.body.phone || '').trim() || null,
    email: (req.body.email || '').trim() || null,
    birthday: memberType === 'student' ? (req.body.birthday || '').trim() || null : null,
    gradeLevel: memberType === 'student' ? (req.body.gradeLevel || '').trim() || null : null,
    medicalNotes: (req.body.medicalNotes || '').trim() || null,
    familyIdRaw: Number.isInteger(familyIdRaw) ? familyIdRaw : null,
    newFamilyName,
    isPrimaryParent: req.body.isPrimaryParent === '1',
  };
}

// A typed "new family" name (see main-admin-member-edit.ejs's own field)
// wins over the dropdown when both are somehow present, and reuses an
// existing family of that exact name rather than creating a duplicate -
// same "create-or-reuse" shape as ensureFamilyForParent in the legacy
// Members import (routes/admin-members.js), just driven by a form field
// here instead of a spreadsheet column.
async function resolveFamilyId(f) {
  if (f.newFamilyName) {
    const existing = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(f.newFamilyName);
    if (existing) return existing.id;
    const info = await db.prepare('INSERT INTO families (name) VALUES (?)').run(f.newFamilyName);
    return info.lastInsertRowid;
  }
  return f.familyIdRaw;
}

router.get('/new', async (req, res) => {
  res.render('main-admin-member-edit', {
    title: 'Add Member',
    mode: 'create',
    member: {
      member_type: 'student',
      name: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      phone: '',
      email: '',
      photo_path: null,
      birthday: '',
      grade_level: '',
      medical_notes: '',
      is_primary_parent: 0,
    },
    families: await allFamilies(),
    memberFamilyId: null,
    gradeLevels: GRADE_LEVELS,
    error: req.query.error || null,
  });
});

router.post('/new', async (req, res) => {
  const f = memberFormFields(req);
  if (!f.name) return res.redirect('/main-admin/members/new?error=' + encodeURIComponent('Name is required.'));
  const exists = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?)').get(f.name);
  if (exists) return res.redirect('/main-admin/members/new?error=' + encodeURIComponent(`"${f.name}" is already in the member list.`));

  const memberCode = await generateMemberCode();
  const info = await db
    .prepare(
      `INSERT INTO members (name, barcode, member_code, member_type, address, city, state, zip, phone, email, birthday, grade_level, medical_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(f.name, memberCode, memberCode, f.memberType, f.address, f.city, f.state, f.zip, f.phone, f.email, f.birthday, f.gradeLevel, f.medicalNotes);

  await setMemberFamily(info.lastInsertRowid, await resolveFamilyId(f));
  await setPrimaryParent(info.lastInsertRowid, f.isPrimaryParent);

  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`${f.name} added.`));
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  member.birthdayLabel = member.birthday ? formatDateNumeric(member.birthday) : null;

  const family = await db
    .prepare('SELECT f.name AS "familyName" FROM members m LEFT JOIN families f ON f.id = m.family_id WHERE m.id = ?')
    .get(id);
  const restOfFamily = await familyOf(id);

  res.render('main-admin-member-profile', {
    title: member.name,
    member,
    familyName: family ? family.familyName : null,
    familyMembers: [member, ...restOfFamily].sort(byLastName),
    rosters: await rostersForMember(id),
    schedule: await getMemberSchedule(id),
    history: (await attendanceHistoryForMember(id)).map((r) => ({
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'present' ? 'Present' : r.status === 'late' ? 'Late' : 'Absent',
      status: r.status,
    })),
  });
});

router.get('/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  res.render('main-admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    families: await allFamilies(),
    memberFamilyId: member.family_id,
    gradeLevels: GRADE_LEVELS,
    error: req.query.error || null,
  });
});

router.post('/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = memberFormFields(req);
  if (!f.name) return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent('Name is required.'));
  const clash = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND id != ?').get(f.name, id);
  if (clash) return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent(`"${f.name}" is already in the member list.`));

  await db
    .prepare(
      `UPDATE members SET name = ?, member_type = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?,
         birthday = ?, grade_level = ?, medical_notes = ? WHERE id = ?`
    )
    .run(f.name, f.memberType, f.address, f.city, f.state, f.zip, f.phone, f.email, f.birthday, f.gradeLevel, f.medicalNotes, id);
  await setMemberFamily(id, await resolveFamilyId(f));
  await setPrimaryParent(id, f.isPrimaryParent);

  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`${f.name} updated.`));
});

// --- Delete / archive (single row and Select-All-across-pages bulk,
// mirroring routes/admin-members.js's identical mechanics). ---

async function deleteMemberById(id) {
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return null;
  await db.prepare('DELETE FROM members WHERE id = ?').run(id);
  await deletePhotoFile(member.photo_path);
  return member;
}

router.post('/:id/delete', async (req, res) => {
  const member = await deleteMemberById(parseInt(req.params.id, 10));
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.'));
});

router.post('/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE members SET active = 0 WHERE id = ?').run(id);
  res.redirect('/main-admin/members?notice=' + encodeURIComponent('Member archived.'));
});

router.post('/:id/unarchive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE members SET active = 1 WHERE id = ?').run(id);
  res.redirect('/main-admin/members?archived=1&notice=' + encodeURIComponent('Member restored.'));
});

module.exports = router;
