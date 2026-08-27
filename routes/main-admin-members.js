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
const { formatDateLabel, formatDateNumeric, ageFromBirthday, isValidISODate } = require('../utils/dates');
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
  byLastName,
} = require('../utils/members');
const { getMemberSchedule } = require('../utils/schedule');
const { portalStatusForMembers, sectionIdsForMembers, setMemberSections, setMemberRoles } = require('../utils/portalPermissions');
const {
  resolveFamilyId: resolveIntakeFamilyId,
  createParentMember,
  createChildMember,
  uploadIntakePhotos,
  parseArrayField,
} = require('../utils/memberIntake');
const membershipApprovals = require('../utils/membershipApprovals');

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

// A real request: "main admin protal members should also have an
// archive tab" and "there should be a tab that says approvals... there
// should be another tab under main admin members that says settings."
// Members/Archive share the exact same roster-listing/pagination/search
// code below (just showArchived flips), Approvals/Settings each fetch
// their own small, unrelated dataset instead.
const MEMBERS_TABS = ['members', 'approvals', 'settings', 'archive'];

router.get('/', async (req, res) => {
  const activeTab = MEMBERS_TABS.includes(req.query.tab) ? req.query.tab : 'members';

  if (activeTab === 'approvals') {
    return res.render('main-admin-members', {
      title: 'Members',
      activeTab,
      pending: await membershipApprovals.listPendingRequests(),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (activeTab === 'settings') {
    return res.render('main-admin-members', {
      title: 'Members',
      activeTab,
      templates: await membershipApprovals.getLetterTemplates(),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const showArchived = activeTab === 'archive';
  const q = (req.query.q || '').trim().toLowerCase();

  let withRosters = (await membersWithDetails(typeFilter, familyFilter))
    .filter((m) => (showArchived ? Number(m.active) === 0 : Number(m.active) === 1))
    .map((m) => ({ ...m, age: ageFromBirthday(m.birthday), birthdayLabel: m.birthday ? formatDateNumeric(m.birthday) : null }));
  if (q) withRosters = withRosters.filter((m) => m.name.toLowerCase().includes(q));

  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(withRosters, parsePage(req.query.page), pageSize);

  // "Edit Permissions" bulk mode - same "current page only" scope as
  // routes/admin-members.js's own version, see that file's own comment.
  const pageMemberIds = pagination.items.map((m) => m.id);
  const sections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const roles = await db.prepare('SELECT * FROM roles ORDER BY label').all();
  const sectionIdsByMember = await sectionIdsForMembers(pageMemberIds);
  const portalStatusByMember = await portalStatusForMembers(pageMemberIds);

  res.render('main-admin-members', {
    title: 'Members',
    activeTab,
    members: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref:
      `/main-admin/members?tab=${activeTab}&` +
      (typeFilter ? `type=${typeFilter}&` : '') +
      (familyFilter ? `family=${familyFilter}&` : '') +
      (q ? `q=${encodeURIComponent(q)}&` : ''),
    typeFilter,
    familyFilter,
    showArchived,
    q: req.query.q || '',
    families: await allFamilies(),
    sections,
    roles,
    sectionIdsByMember,
    portalStatusByMember,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// "Edit Permissions" bulk save - see routes/admin-members.js's own
// identical route for the full comment on what this reconciles.
// req.portalAccount DOES exist on this session (a real member_accounts-
// backed Main Admin login), so grants are attributed here, unlike the
// Co-op Admin version.
router.post('/bulk-permissions', async (req, res) => {
  // Field names are `sections_<memberId>[]`/`roles_<memberId>[]` - see
  // routes/admin-members.js's own identical route for why (qs's
  // small-integer-bracket-as-array-index behavior would otherwise
  // silently mangle this).
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  for (const memberId of memberIds) {
    const sectionIds = [].concat(req.body[`sections_${memberId}`] || []).map((id) => parseInt(id, 10)).filter(Boolean);
    const roleIds = [].concat(req.body[`roles_${memberId}`] || []).map((id) => parseInt(id, 10)).filter(Boolean);
    await setMemberSections(memberId, sectionIds);
    await setMemberRoles(memberId, roleIds, req.portalAccount.id);
  }
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`Permissions updated for ${memberIds.length} member(s).`));
});

// --- Approvals (membership requests - member_accounts still 'pending')
// and Settings (the approval/deny letter templates that get auto-sent
// when those buttons are clicked below). ---

router.post('/approvals/:accountId/approve', async (req, res) => {
  const account = await membershipApprovals.approveRequest(parseInt(req.params.accountId, 10), req.portalAccount.id);
  res.redirect('/main-admin/members?tab=approvals&notice=' + encodeURIComponent(account ? `${account.memberName} approved.` : 'Request approved.'));
});

router.post('/approvals/:accountId/deny', async (req, res) => {
  const account = await membershipApprovals.denyRequest(parseInt(req.params.accountId, 10));
  res.redirect('/main-admin/members?tab=approvals&notice=' + encodeURIComponent(account ? `${account.memberName} denied.` : 'Request denied.'));
});

router.post('/approvals/:accountId/delete', async (req, res) => {
  const account = await membershipApprovals.deleteRequest(parseInt(req.params.accountId, 10));
  res.redirect('/main-admin/members?tab=approvals&notice=' + encodeURIComponent(account ? `${account.memberName}'s request deleted.` : 'Request deleted.'));
});

router.post('/settings/letters/:kind', async (req, res) => {
  const kind = req.params.kind;
  const subject = (req.body.subject || '').trim();
  const body = (req.body.body || '').trim();
  if (kind !== 'approval' && kind !== 'denial') return res.redirect('/main-admin/members?tab=settings');
  if (!subject || !body) {
    return res.redirect('/main-admin/members?tab=settings&error=' + encodeURIComponent('Subject and body are both required.'));
  }
  await membershipApprovals.updateLetterTemplate(kind, subject, body);
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent(`${kind === 'approval' ? 'Approval' : 'Denial'} letter saved.`));
});

// --- Edit mode bulk actions (checkboxes + Actions dropdown on the
// Members tab) - a real request: "there should be an edit button on
// member page that says edit. when you click it it will show check
// boxes next to every member. you can select individusl, all or none, a
// dropdown also appears and says actions, delete or archive are the
// options." ---

router.post('/bulk-delete', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  for (const id of memberIds) await deleteMemberById(id);
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`Deleted ${memberIds.length} member(s).`));
});

router.post('/bulk-archive', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => '?').join(',');
    await db.prepare(`UPDATE members SET active = 0 WHERE id IN (${placeholders})`).run(...memberIds);
  }
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`Archived ${memberIds.length} member(s).`));
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

// "Add Member" now shares the same family-intake form/logic as the
// Membership Form (routes/membership.js) and Co-op Admin's own Add
// Member (routes/admin-members.js) - a real request: "Add member and
// membership request form should be the same." Editing an EXISTING
// member (GET/POST /:id/edit below) is unaffected - it keeps its own
// single-person main-admin-member-edit.ejs form and this file's own
// resolveFamilyId/memberFormFields helpers.
async function allSetupTeams() {
  return db.prepare('SELECT id, day, title FROM setup_teams ORDER BY day, LOWER(title)').all();
}

router.get('/new', async (req, res) => {
  res.render('member-intake-form', {
    title: 'Add Member',
    portal: 'main_admin',
    formAction: '/main-admin/members/new',
    backHref: '/main-admin/members',
    submitLabel: 'Add Member',
    isAdmin: true,
    families: await allFamilies(),
    setupTeams: await allSetupTeams(),
    gradeLevels: GRADE_LEVELS,
    error: req.query.error || null,
    notice: null,
  });
});

router.post('/new', uploadIntakePhotos('/main-admin/members/new'), async (req, res) => {
  const body = req.body;
  const back = '/main-admin/members/new';

  const address = {
    address: (body.address || '').trim() || null,
    city: (body.city || '').trim() || null,
    state: (body.state || '').trim() || null,
    zip: (body.zip || '').trim() || null,
  };

  const parents = parseArrayField(body, 'parents')
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p && (p.name || '').trim());
  if (parents.length === 0) {
    return res.redirect(back + '?error=' + encodeURIComponent('At least one parent/guardian name is required.'));
  }

  const children = parseArrayField(body, 'children')
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c && (c.name || '').trim());
  if (children.length === 0) {
    return res.redirect(back + '?error=' + encodeURIComponent('Please add at least one student.'));
  }

  const familyId = await resolveIntakeFamilyId({ familyId: body.familyId, newFamilyName: body.newFamilyName, homeschoolDuration: body.homeschoolDuration });

  for (const p of parents) {
    await createParentMember(familyId, address, {
      name: p.name.trim(),
      email: (p.email || '').trim() || null,
      phone: (p.phone || '').trim() || null,
      isPrimaryParent: p.isPrimaryParent === '1',
      cleanupTeamId: parseInt(p.cleanupTeamId, 10) || null,
    });
  }

  for (const c of children) {
    const photoFile = (req.files || []).find((f) => f.fieldname === `children[${c.index}][photo]`);
    await createChildMember(
      familyId,
      address,
      {
        name: c.name.trim(),
        birthday: isValidISODate((c.birthday || '').trim()) ? c.birthday.trim() : null,
        gradeLevel: GRADE_LEVELS.includes(c.gradeLevel) ? c.gradeLevel : null,
        medicalNotes: (c.medicalNotes || '').trim() || null,
      },
      photoFile
    );
  }

  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`Added ${parents.length + children.length} member(s).`));
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

  const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const memberSectionIds = (await sectionIdsForMembers([id]))[id];
  const portalStatus = (await portalStatusForMembers([id]))[id];
  const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();

  res.render('main-admin-member-profile', {
    title: member.name,
    member,
    familyName: family ? family.familyName : null,
    familyMembers: [member, ...restOfFamily].sort(byLastName),
    rosters: await rostersForMember(id),
    schedule: await getMemberSchedule(id),
    memberSections: allSections.filter((s) => memberSectionIds.has(s.id)),
    portalRoles: portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null,
    history: (await attendanceHistoryForMember(id)).map((r) => ({
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'present' ? 'Present' : r.status === 'late' ? 'Late' : 'Absent',
      status: r.status,
    })),
  });
});

// A real request (Approvals tab): "you can click the name and view their
// membership form and edit, add portal settings etc. save." Portal
// Settings (role checkboxes) only renders when this member actually has
// an account (portalStatus.account) - a pending applicant always does,
// but plenty of ordinary members never sign up for portal access at
// all, and there's nothing to grant on Save for those.
router.get('/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  const portalStatus = (await portalStatusForMembers([id]))[id];

  res.render('main-admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    families: await allFamilies(),
    memberFamilyId: member.family_id,
    gradeLevels: GRADE_LEVELS,
    portalAccount: portalStatus.account,
    portalRoleIds: portalStatus.roleIds,
    allRoles: await db.prepare('SELECT * FROM roles ORDER BY label').all(),
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

  // Portal Settings - only present in the submitted form (and only ever
  // acted on here) when this member actually has an account; see this
  // route's own GET handler comment.
  const portalStatus = (await portalStatusForMembers([id]))[id];
  if (portalStatus.account) {
    const roleIds = [].concat(req.body.roleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
    await setMemberRoles(id, roleIds, req.portalAccount.id);
  }

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

// A real request: "next to each members name under archive there
// should be a button that says reactivate to make them a member again
// and remove them from the archive list."
router.post('/:id/unarchive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE members SET active = 1 WHERE id = ?').run(id);
  res.redirect('/main-admin/members?tab=archive&notice=' + encodeURIComponent('Member reactivated.'));
});

module.exports = router;
