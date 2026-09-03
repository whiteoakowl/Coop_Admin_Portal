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
// A real later request: "Membership forms on the co-op admin page
// should be the same as the main admin member profiles." The Add/Edit
// Member form here now shares views/partials/member-form-fields.ejs
// with routes/admin-members.js's own edit page (photo upload, Setup
// Team checklist, and - Main-Admin-only - the Admin Positions checklist
// included), rather than the separate, scoped-down markup this file
// used to render on its own. Printable name-tag/schedule-card generation
// still stay Co-op-Admin-only (print/file-heavy features tied to the
// physical badge system, not membership data itself). CSV export and
// Excel bulk import live here too - a real request: "add member button,
// edit permissions button, edit, import, export buttons should be under
// the member tab" - sharing utils/memberImport.js's logic with
// routes/admin-members.js's own identical feature rather than a second,
// drifting copy.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { formatDateLabel, formatDateNumeric, formatTime, ageFromBirthday, isValidISODate } = require('../utils/dates');
const { GRADE_LEVELS } = require('../utils/classSchedule');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { spreadsheetFileFilter } = require('../utils/uploads');
const { uploadMemberPhoto, savePhotoFile, deletePhotoFile } = require('../utils/memberPhoto');
const { allSetupTeams, cleanupTeamIdsForMember } = require('../utils/setup');
const { listAdminPositions, adminPositionIdsForMember, syncMemberAdminPositions } = require('../utils/adminPositions');
const { buildTemplateWorkbook, readRowsFromFile, sendCsv } = require('../utils/spreadsheet');
const memberImport = require('../utils/memberImport');
const {
  familyOf,
  allFamilies,
  setMemberFamily,
  setPrimaryParent,
  rostersForMember,
  membersWithDetails,
  byLastName,
} = require('../utils/members');
const { getMemberSchedule, scheduleList } = require('../utils/schedule');
const { portalStatusForMembers, sectionIdsForMembers, setMemberSections, setMemberRoles } = require('../utils/portalPermissions');
const { clearVolunteerMembershipIfNotParent } = require('../utils/volunteers');
const { hashPassword, findAccountByEmail } = require('../utils/portalAuth');
const {
  resolveFamilyId: resolveIntakeFamilyId,
  createParentMember,
  createChildMember,
  uploadIntakePhotos,
  parseArrayField,
} = require('../utils/memberIntake');
const membershipApprovals = require('../utils/membershipApprovals');
const membershipHandbook = require('../utils/membershipHandbook');
const membershipFormFields = require('../utils/membershipFormFields');
const { sanitizePostBody } = require('../utils/sanitizeHtml');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_members'));

const MEMBER_TYPES = ['student', 'parent', 'admin'];
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

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

// Same shape as routes/admin-members.js's own formatAttendanceHistory -
// used by both the single-member and family-wide "All" views on the
// profile page's own Attendance tab.
function formatAttendanceHistory(rows) {
  return rows.map((r) => ({
    rosterName: r.rosterName,
    dateLabel: formatDateLabel(r.date),
    statusLabel: r.status === 'present' ? 'Present' : r.status === 'late' ? 'Late' : 'Absent',
    status: r.status,
    checkInTime: r.checkInTime ? formatTime(r.checkInTime) : null,
    checkOutTime: r.checkOutTime ? formatTime(r.checkOutTime) : null,
  }));
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
      handbookHtml: await membershipHandbook.getHandbookHtml(),
      paymentInfo: await membershipHandbook.getPaymentInfo(),
      parentFormFields: await membershipFormFields.listFields('parent'),
      childFormFields: await membershipFormFields.listFields('child'),
      fieldTypes: membershipFormFields.FIELD_TYPES,
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

// A real request: "add member button, edit permissions button, edit,
// import, export buttons should be under the member tab above filter."
// Same export shape as routes/admin-members.js's own /members/export.csv,
// via the shared utils/memberImport.js.
router.get('/export.csv', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const members = await membersWithDetails(typeFilter, familyFilter);
  const lines = memberImport.buildMembersExportCsvLines(members);
  sendCsv(res, `members${typeFilter ? '-' + typeFilter : ''}.csv`, lines);
});

router.get('/import-template.xlsx', (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['First Name', 'Last Name', 'Type', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Birthday', 'Grade Level', 'Medical/Allergy Notes', 'Parent First Name', 'Parent Last Name'],
    [
      ['Jane', 'Smith', 'Parent', '123 Main St', 'Anytown', 'NC', '27330', '555-987-6543', 'jane@example.com', '', '', '', '', ''],
      ['Alice', 'Smith', 'Student', '123 Main St', 'Anytown', 'NC', '27330', '555-123-4567', '', '2015-04-12', '5th Grade', 'Peanut allergy', 'Jane', 'Smith'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="members-import-template.xlsx"');
  res.send(buffer);
});

router.post('/import', importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.redirect('/main-admin/members?error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(memberImport.normalizeImportRow).filter((r) => r.name);
  } catch (err) {
    return res.redirect('/main-admin/members?error=' + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  const { mergeCandidates, summary } = await memberImport.importMembersFromRows(rows);

  if (mergeCandidates.length === 0) {
    return res.redirect('/main-admin/members?notice=' + encodeURIComponent(summary));
  }

  res.render('main-admin-members-import-confirm', {
    title: 'Confirm Import Merge',
    summary,
    candidates: mergeCandidates.map((c) => ({
      memberId: c.memberId,
      memberName: c.memberName,
      fields: memberImport.IMPORT_MERGE_FIELDS.filter(([field]) => c.updates[field] !== undefined).map(([field, label]) => ({
        label,
        value: c.updates[field],
      })),
      payload: JSON.stringify(c.updates),
    })),
  });
});

router.post('/import/confirm', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const payloads = [].concat(req.body.payloads || []);
  const allMemberIds = [].concat(req.body.allMemberIds || []).map((id) => parseInt(id, 10));

  const merged = await memberImport.applyImportMerges(memberIds, payloads, allMemberIds);

  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`Merged new profile details into ${merged} existing member(s).`));
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

// A real request: "make every member a user... give everyone the
// password changeme123. all members will have accounts." One-shot bulk
// bootstrap: creates a portal account (status 'active', so no separate
// approval step) for every ACTIVE member who doesn't already have one,
// using their own email on file as their login. A member with no email
// can't get one (member_accounts.email is required) - skipped, not
// silently dropped, so the admin sees exactly how many still need an
// email added before they can log in.
router.post('/bulk-create-accounts', async (req, res) => {
  const members = await db.prepare("SELECT id, email FROM members WHERE active = 1").all();
  const existingMemberIds = new Set((await db.prepare('SELECT member_id FROM member_accounts').all()).map((r) => r.member_id));
  const passwordHash = hashPassword('changeme123');

  let created = 0;
  let skippedNoEmail = 0;
  let skippedEmailInUse = 0;
  for (const m of members) {
    if (existingMemberIds.has(m.id)) continue;
    const email = (m.email || '').trim();
    if (!email) {
      skippedNoEmail += 1;
      continue;
    }
    if (await findAccountByEmail(email)) {
      skippedEmailInUse += 1;
      continue;
    }
    await db
      .prepare(
        "INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at, approved_by_account_id) VALUES (?, ?, ?, 'active', now_text(), ?)"
      )
      .run(m.id, email, passwordHash, req.portalAccount.id);
    created += 1;
  }

  const parts = [`Created ${created} account(s) with the password "changeme123".`];
  if (skippedNoEmail > 0) parts.push(`${skippedNoEmail} member(s) skipped - no email on file.`);
  if (skippedEmailInUse > 0) parts.push(`${skippedEmailInUse} member(s) skipped - their email is already used by another account.`);
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(parts.join(' ')));
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
  const body = sanitizePostBody(req.body.body || '');
  if (kind !== 'approval' && kind !== 'denial') return res.redirect('/main-admin/members?tab=settings');
  if (!subject || !body) {
    return res.redirect('/main-admin/members?tab=settings&error=' + encodeURIComponent('Subject and body are both required.'));
  }
  await membershipApprovals.updateLetterTemplate(kind, subject, body);
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent(`${kind === 'approval' ? 'Approval' : 'Denial'} letter saved.`));
});

// A real request: "there should be a place at the bottom of the
// membership application to check a box after reading the policy
// handbook." What a family sees on the public form (views/portal-
// register.ejs) is admin-edited here.
router.post('/settings/handbook', async (req, res) => {
  await membershipHandbook.setHandbookHtml(sanitizePostBody(req.body.handbookHtml || ''));
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent('Policy Handbook saved.'));
});

// A real request: "place at the bottom of the application for payment."
// Informational only, matching this app's existing payment convention
// (see utils/membershipHandbook.js's own comment) - no online charge is
// created from this form.
router.post('/settings/payment', async (req, res) => {
  const dollars = parseFloat(req.body.feeDollars || '0');
  const feeCents = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  await membershipHandbook.setPaymentInfo(feeCents, (req.body.instructions || '').trim());
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent('Payment info saved.'));
});

// A real request: "under members in main admin portal there should be a
// settings tab for editing and adding parts of the membership form."
// target is 'parent' or 'child' - which repeatable block (Parent/
// Guardian vs Student) the new question shows up under on both the
// admin-entered Membership Form/Add Member forms and the public self-
// registration application.
router.post('/settings/membership-fields', async (req, res) => {
  const target = req.body.target === 'child' ? 'child' : 'parent';
  const id = await membershipFormFields.createField(target, req.body.label, req.body.fieldType, req.body.options, req.body.isRequired === '1');
  if (!id) return res.redirect('/main-admin/members?tab=settings&error=' + encodeURIComponent('A field label is required.'));
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent('Field added.'));
});

router.post('/settings/membership-fields/:id/update', async (req, res) => {
  await membershipFormFields.updateField(parseInt(req.params.id, 10), req.body.label, req.body.fieldType, req.body.options, req.body.isRequired === '1');
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent('Field saved.'));
});

router.post('/settings/membership-fields/:id/delete', async (req, res) => {
  await membershipFormFields.deleteField(parseInt(req.params.id, 10));
  res.redirect('/main-admin/members?tab=settings&notice=' + encodeURIComponent('Field deleted.'));
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

// Same wantsJson branch as routes/admin-members.js's own identical
// /members/families/new - the shared "+ Add New Family" dialog (public/
// js/member-form.js's initAddFamilyDialog) posts here with
// Accept: application/json from the Add/Edit Member form now that this
// page shares that markup too (see this file's own top comment).
router.post('/families/new', async (req, res) => {
  const name = (req.body.name || '').trim();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  if (!name) {
    const message = 'Family name is required.';
    if (wantsJson) return res.status(400).json({ error: message });
    return res.redirect('/main-admin/members?error=' + encodeURIComponent(message));
  }
  const exists = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) {
    const message = `"${name}" family already exists.`;
    if (wantsJson) return res.status(409).json({ error: message });
    return res.redirect('/main-admin/members?error=' + encodeURIComponent(message));
  }
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(name)).lastInsertRowid;
  if (wantsJson) return res.json({ id: familyId, name });
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
    // Same shape as routes/admin-members.js's own memberFormFields, now
    // that the two portals' edit forms share partials/member-form-
    // fields.ejs - see this file's own top comment.
    cleanupTeamIds:
      memberType === 'parent'
        ? [].concat(req.body.cleanupTeamIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
        : null,
    adminPositionIds:
      memberType === 'admin'
        ? [].concat(req.body.adminPositionIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
        : null,
  };
}

// Keeps setup_team_members in sync with the Cleanup Team checkboxes on a
// parent's profile - same shape as routes/admin-members.js's own
// syncCleanupTeams. Always clears existing rows first (not just when
// teamIds is a real list) so converting an existing parent to student/
// admin drops their stale team membership instead of leaving them stuck
// on a chart they can no longer manage from their own profile.
async function syncCleanupTeams(memberId, teamIds) {
  await db.prepare('DELETE FROM setup_team_members WHERE member_id = ?').run(memberId);
  if (!teamIds) return;
  const link = db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?) ON CONFLICT (team_id, member_id) DO NOTHING');
  for (const teamId of teamIds) await link.run(teamId, memberId);
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
// member (GET/POST /:id/edit below) now ALSO shares its own field
// markup with Co-op Admin's edit form (partials/member-form-fields.ejs -
// see this file's own top comment), including utils/setup.js's own
// allSetupTeams imported above.
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
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
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
      customFieldValues: p.customFields,
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
        customFieldValues: c.customFields,
      },
      photoFile
    );
  }

  res.redirect('/main-admin/members?notice=' + encodeURIComponent(`Added ${parents.length + children.length} member(s).`));
});

// A real request: "co-op admin portal and main admin portal, members...
// click the class schedules tab, click print" - Main Admin's own member
// profile Schedule tab had no print route at all (Co-op Admin's own
// routes/admin-schedule.js's GET /schedule/print was never mounted under
// /main-admin). Reuses the exact same admin-schedule-print.ejs view and
// utils/schedule.js's scheduleList (both already portal-agnostic - the
// members table itself isn't split per portal) rather than duplicating
// either, registered ahead of GET /:id below so "schedule-print" is never
// swallowed as a member id.
router.get('/schedule-print', async (req, res) => {
  const familyId = req.query.familyId ? parseInt(req.query.familyId, 10) : null;
  const rows = await scheduleList({ memberId: req.query.memberId ? parseInt(req.query.memberId, 10) : null, familyId });
  res.render('admin-schedule-print', { title: 'Print Schedules', rows, compact: !!familyId });
});

const PROFILE_TABS = ['profile', 'schedule', 'attendance'];

// A real request: "class schedule and attendance should be tabs" (the
// profile page used to just stack every section on one long page) -
// same view-tabs shape and same family-wide "All" behavior as routes/
// admin-members.js's own identical GET /members/:id, just rendering
// main-admin-member-profile.ejs instead. See that route's own comment
// for the family-view rationale.
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  member.birthdayLabel = member.birthday ? formatDateNumeric(member.birthday) : null;
  const tab = PROFILE_TABS.includes(req.query.tab) ? req.query.tab : 'profile';

  const family = await db
    .prepare('SELECT f.name AS "familyName" FROM members m LEFT JOIN families f ON f.id = m.family_id WHERE m.id = ?')
    .get(id);
  const restOfFamily = await familyOf(id);
  const familyRoster = [member, ...restOfFamily].sort(byLastName);
  const familyAllDefault = familyRoster.length > 1 && member.member_type === 'parent';
  const scheduleFamilyAll = tab === 'schedule' && familyRoster.length > 1 && (req.query.family === 'all' || familyAllDefault);
  const attendanceFamilyAll = tab === 'attendance' && familyRoster.length > 1 && (req.query.family === 'all' || familyAllDefault);

  const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const memberSectionIds = (await sectionIdsForMembers([id]))[id];
  const portalStatus = (await portalStatusForMembers([id]))[id];
  const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();

  res.render('main-admin-member-profile', {
    title: member.name,
    member,
    tab,
    familyName: family ? family.familyName : null,
    familyMembers: [member, ...restOfFamily].sort(byLastName),
    familyRoster,
    rosters: await rostersForMember(id),
    schedule: await getMemberSchedule(id),
    scheduleFamilyAll,
    familySchedules: scheduleFamilyAll
      ? await Promise.all(familyRoster.map(async (m) => ({ member: m, schedule: await getMemberSchedule(m.id) })))
      : null,
    memberSections: allSections.filter((s) => memberSectionIds.has(s.id)),
    // Named memberPortalRoles, not portalRoles - that name is already the
    // LOGGED-IN admin's own roles, implicitly supplied via res.locals for
    // partials/portal-nav.ejs's portal-switcher (see that file's own
    // comment). Reusing it here for the profile SUBJECT's roles instead
    // shadowed the real one and crashed portal-nav.ejs's `.length` check
    // (portalRoles ending up `null`, not `[]`) for the common case of a
    // member with no portal account of their own.
    memberPortalRoles: portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null,
    attendanceFamilyAll,
    history: attendanceFamilyAll ? null : formatAttendanceHistory(await attendanceHistoryForMember(id)),
    familyAttendanceHistories: attendanceFamilyAll
      ? await Promise.all(familyRoster.map(async (m) => ({ member: m, history: formatAttendanceHistory(await attendanceHistoryForMember(m.id)) })))
      : null,
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
    setupTeams: await allSetupTeams(),
    memberCleanupTeamIds: await cleanupTeamIdsForMember(id),
    adminPositions: await listAdminPositions(),
    memberAdminPositionIds: await adminPositionIdsForMember(id),
    portalAccount: portalStatus.account,
    portalRoleIds: portalStatus.roleIds,
    allRoles: await db.prepare('SELECT * FROM roles ORDER BY label').all(),
    // A real request: "there should not be an edit permissions button [on
    // the profile page], it should just show the member's sections and
    // portal permissions. When you click the edit button... that is where
    // you can control portal settings per member." Sections used to only
    // be editable from the Members list's own bulk "Edit Permissions"
    // mode (routes/main-admin-members.js's own /bulk-permissions route,
    // unaffected) - now also editable per-member right here, alongside
    // the password/role fields this box already had.
    allSections: await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all(),
    memberSectionIds: (await sectionIdsForMembers([id]))[id],
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: "when editing a member profile, there is a button that
// says add parent/student. when you click this button it will ask
// student or parent, name, if student then it asks birthday and grade.
// save." A lightweight companion to the full Add Member form (routes/
// main-admin-members.js's own /new, used to create a brand-new family) -
// this one always adds onto the family of the member whose Edit Profile
// page it was opened from, and only collects the few fields that form
// actually asked for here (no email/phone/setup team/custom fields), via
// utils/memberIntake.js's own createParentMember/createChildMember so
// the new person still gets a real, individual profile the exact same
// way every other entry point creates one. A later real request: "after
// adding a new member to a family it will create a profile for that
// member, still connected to the parent, using the same address as the
// parent" - the new member's address/city/state/zip are copied from
// this member (the one whose Edit Profile page the dialog was opened
// from), same as how the full Add Member form's own single "Family
// Address" section already applies one shared address to every parent/
// child in that submission.
router.post('/:id/quick-add-family-member', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const back = `/main-admin/members/${id}/edit`;
  const member = await db.prepare('SELECT family_id, address, city, state, zip FROM members WHERE id = ?').get(id);
  if (!member || member.family_id == null) return res.redirect(back + '?error=' + encodeURIComponent('This member has no family yet - choose or add one above and save first.'));

  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(back + '?error=' + encodeURIComponent('Name is required.'));
  const memberType = req.body.memberType === 'parent' ? 'parent' : 'student';
  const address = { address: member.address, city: member.city, state: member.state, zip: member.zip };

  if (memberType === 'parent') {
    await createParentMember(member.family_id, address, { name, isPrimaryParent: false });
  } else {
    const birthday = isValidISODate((req.body.birthday || '').trim()) ? req.body.birthday.trim() : null;
    const gradeLevel = GRADE_LEVELS.includes(req.body.gradeLevel) ? req.body.gradeLevel : null;
    await createChildMember(member.family_id, address, { name, birthday, gradeLevel, medicalNotes: null });
  }

  res.redirect(back + '?notice=' + encodeURIComponent(`${name} added to the family.`));
});

router.post('/:id/edit', uploadMemberPhoto((req) => `/main-admin/members/${req.params.id}/edit`), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = memberFormFields(req);
  if (!f.name) return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent('Name is required.'));
  const clash = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND id != ?').get(f.name, id);
  if (clash) return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent(`"${f.name}" is already in the member list.`));
  const existing = await db.prepare('SELECT photo_path FROM members WHERE id = ?').get(id);
  const photoPath = req.file ? await savePhotoFile(req.file) : existing ? existing.photo_path : null;
  // A newly uploaded photo replaces the old one in photo_path below - see
  // routes/admin-members.js's own identical POST /members/:id/edit.
  if (req.file && existing && existing.photo_path) await deletePhotoFile(existing.photo_path);

  // A real request: "No creating users. All Members should already have
  // an account. Each member profile should have a space for password."
  // - checked before the UPDATE below so a rejected password doesn't
  // still silently save the rest of the form with no feedback.
  const password = req.body.password || '';
  let portalStatus = (await portalStatusForMembers([id]))[id];
  if (password) {
    if (password.length < 8) {
      return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent('Password must be at least 8 characters.'));
    }
    if (!portalStatus.account) {
      if (!f.email) {
        return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent('An email address is required to create a portal account.'));
      }
      const emailClash = await findAccountByEmail(f.email);
      if (emailClash) {
        return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent('That email is already in use by another portal account.'));
      }
    }
  }

  await db
    .prepare(
      `UPDATE members SET name = ?, member_type = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?,
         photo_path = ?, birthday = ?, grade_level = ?, medical_notes = ? WHERE id = ?`
    )
    .run(f.name, f.memberType, f.address, f.city, f.state, f.zip, f.phone, f.email, photoPath, f.birthday, f.gradeLevel, f.medicalNotes, id);
  await syncCleanupTeams(id, f.cleanupTeamIds);
  await syncMemberAdminPositions(id, f.adminPositionIds);
  await clearVolunteerMembershipIfNotParent(id, f.memberType);
  await setMemberFamily(id, await resolveFamilyId(f));
  await setPrimaryParent(id, f.isPrimaryParent);

  if (password) {
    if (portalStatus.account) {
      await db.prepare('UPDATE member_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(password), portalStatus.account.id);
    } else {
      const info = await db
        .prepare(
          "INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at, approved_by_account_id) VALUES (?, ?, ?, 'active', now_text(), ?)"
        )
        .run(id, f.email, hashPassword(password), req.portalAccount.id);
      portalStatus = { account: { id: info.lastInsertRowid }, roleIds: new Set() };
    }
  }

  // Portal Settings' role checkboxes - only meaningful once this member
  // actually has an account (either already did, or was just created
  // above by setting a password in this same submit).
  if (portalStatus.account) {
    const roleIds = [].concat(req.body.roleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
    await setMemberRoles(id, roleIds, req.portalAccount.id);
  }

  // Sections - unlike Portal Roles, not gated behind having an account:
  // Sections scope what an admin can see/manage regardless of whether
  // this member ever logs into a portal themselves.
  const sectionIds = [].concat(req.body.sectionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await setMemberSections(id, sectionIds);

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

// A real request: "add an icon that shows sending something. when you
// click it a pop up will appear and ask, do you want to add this name
// tag to the request log? yes, no buttons, close windows." Same queue
// the public routes/name-tag.js form writes to and Design > Print's
// Name Tag Requests panel reads from - see routes/admin-members.js's
// own mirror of this route for Co-op Admin's Member List.
// A real request: "when clicking the icon on member list to send to name
// tags request log the page should not refresh everytime." isFetch mirrors
// routes/admin-members.js's own copy of this same helper (from routes/
// admin-substitutes.js originally) - a fetch() caller (public/js/member-
// name-tag-request.js) gets JSON back instead of the redirect, so the
// click never navigates the page.
function isFetch(req) {
  return req.get('X-Requested-With') === 'fetch';
}

router.post('/:id/request-name-tag', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT id FROM members WHERE id = ?').get(id);
  if (member) {
    await db
      .prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'both', 'Added from Member List by admin')")
      .run(id);
  }
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect('/main-admin/members');
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
