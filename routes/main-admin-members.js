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
const { formatDateLabel, formatDateNumeric, formatTime, ageFromBirthday, isChildAge, isValidISODate } = require('../utils/dates');
const { GRADE_LEVELS, CLASS_DAY_LABELS_FULL, listActiveClassDays } = require('../utils/classSchedule');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE, memberFamilyGroupKey } = require('../utils/pagination');
const { spreadsheetFileFilter, documentFileFilter, DOCUMENT_MIME_BY_EXT, imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, generateKey } = require('../utils/storage');
const { saveUpload, urlForUpload } = require('../utils/uploadBackend');
const { notify } = require('../utils/notifications');
const smsProvider = require('../utils/smsProvider');
const path = require('path');
const fs = require('fs');
const { uploadMemberPhoto, savePhotoFile, deletePhotoFile } = require('../utils/memberPhoto');
const { allSetupTeams } = require('../utils/setup');
const { listAdminPositions, adminPositionIdsForMember, syncMemberAdminPositions } = require('../utils/adminPositions');
const { buildTemplateWorkbook, readRowsFromFile, sendCsv, toCsvRow } = require('../utils/spreadsheet');
const { renderViewToPdf } = require('../utils/pdfRender');

function sendPdf(res, filename, pdfBuffer) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdfBuffer);
}
const memberImport = require('../utils/memberImport');
const {
  familyOf,
  allFamilies,
  setMemberFamily,
  setPrimaryParent,
  membersWithDetails,
  byLastName,
  avatarColorFor,
} = require('../utils/members');
const { getMemberSchedule, scheduleList } = require('../utils/schedule');
const { portalStatusForMembers, sectionIdsForMembers, setMemberSections, setMemberRoles, addMemberSections, addMemberRoles } = require('../utils/portalPermissions');
const { clearVolunteerMembershipIfNotParent } = require('../utils/volunteers');
const { hashPassword, findAccountByEmail, ensurePortalAccountForMember } = require('../utils/portalAuth');
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
const gradeLevelSettings = require('../utils/gradeLevelSettings');
const { listAccountingCategories } = require('../utils/events');
const { sanitizePostBody } = require('../utils/sanitizeHtml');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_members'));

const MEMBER_TYPES = ['student', 'parent', 'admin'];
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

// A real request: "Main admin portal and co-op admin portal. Members.
// Add a text icon to click and a pop up appears allowing you type a
// text message, add an image and send text button and close button."
// Same optional-MMS-image upload pattern routes/admin-members.js's own
// matching /members/:id/text route uses, just this portal's own
// bucket/dir - see that route's own comment for the full reasoning
// (public bucket, Telnyx needs a fetchable URL).
const MAX_MEMBER_TEXT_IMAGE_BYTES = 5 * 1024 * 1024;
const MEMBER_TEXT_IMAGE_BUCKET = 'member-text-images';
const MEMBER_TEXT_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'member-text-images');
if (!createStorageClient() && !fs.existsSync(MEMBER_TEXT_IMAGE_DIR)) {
  try {
    fs.mkdirSync(MEMBER_TEXT_IMAGE_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${MEMBER_TEXT_IMAGE_DIR}:`, err.message);
  }
}
const memberTextImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEMBER_TEXT_IMAGE_BYTES }, fileFilter: imageFileFilter });

// A real request: "add an option to upload the policy handbook as a
// document, pdf, etc." - same local-disk-fallback-or-Supabase-Storage
// convention as routes/admin-documents.js's own uploads, just one
// singleton file instead of a library (utils/membershipHandbook.js's own
// getHandbookFile/setHandbookFile).
const HANDBOOK_FILE_BUCKET = 'documents';
const HANDBOOK_FILE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');
if (!createStorageClient() && !fs.existsSync(HANDBOOK_FILE_DIR)) {
  try {
    fs.mkdirSync(HANDBOOK_FILE_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${HANDBOOK_FILE_DIR}:`, err.message);
  }
}
const handbookFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: documentFileFilter });

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

// Same shape as routes/admin-members.js's own groupAttendanceByRoster - a
// real request: "under each person, each of the attendance rosters this
// member is on will show, then you can click on the class/roster name and
// it will expand and show attendance and dates for that class."
function groupAttendanceByRoster(history) {
  const order = [];
  const byRoster = new Map();
  history.forEach((h) => {
    if (!byRoster.has(h.rosterName)) {
      byRoster.set(h.rosterName, []);
      order.push(h.rosterName);
    }
    byRoster.get(h.rosterName).push(h);
  });
  return order.map((rosterName) => ({ rosterName, rows: byRoster.get(rosterName) }));
}

// --- List ---

// A real request: "main admin protal members should also have an
// archive tab" and "there should be a tab that says approvals... there
// should be another tab under main admin members that says settings."
// Members/Archive share the exact same roster-listing/pagination/search
// code below (just showArchived flips), Approvals/Settings each fetch
// their own small, unrelated dataset instead.
const MEMBERS_TABS = ['members', 'approvals', 'settings', 'archive', 'locked'];

// A real request: "Membership fee and payment should be its own tab...
// Membership form fields should be its own tab... Approval/denial named
// tab... Tab for policy handbook... grade level settings [tab]. All of
// these member settings are currently on one page. They should be moved
// to their own tabs." - nested tabs under the Settings tab above, in the
// order the request listed them.
const SETTINGS_SUBTABS = ['grade-levels', 'fee-payment', 'form-fields', 'approval-denial', 'handbook'];

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

  // A real request: "add a lock icon on each member. Add a subpage
  // called locked. be able to lock members" - every member whose portal
  // account status is 'suspended' (middleware/portalAuth.js's own
  // requirePortalAuth confines that status to /accounting - see that
  // file's own matching comment). A member with no account at all has
  // nothing to lock, so this is necessarily a subset of accounted-for
  // members, not every member.
  if (activeTab === 'locked') {
    const lockedAccounts = await db
      .prepare(
        `SELECT m.*, ma.id AS "accountId", ma.email AS "accountEmail" FROM members m
         JOIN member_accounts ma ON ma.member_id = m.id
         WHERE ma.status = 'suspended'
         ORDER BY LOWER(m.name)`
      )
      .all();
    return res.render('main-admin-members', {
      title: 'Members',
      activeTab,
      lockedMembers: lockedAccounts,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  if (activeTab === 'settings') {
    // A real request: "All of these member settings are currently on one
    // page. They should be moved to their own tabs under member settings
    // for better viewing." - a second, nested level of tabs (settingsTab)
    // under this same top-level Settings tab, same in-page .view-tabs
    // pattern views/portal-profile.ejs already uses for its own Profile/
    // Schedules/Event Signups tabs. Everything's still fetched together
    // either way (each one's its own small, cheap read) rather than
    // re-querying per sub-tab switch.
    // A real request: "Change settings to card style like the gear icon
    // settings" - null (not a default sub-tab) means "show the card
    // grid landing page," same as /main-admin/settings itself (views/
    // main-admin-settings-hub.ejs) has no sub-tab of its own either.
    const settingsTab = SETTINGS_SUBTABS.includes(req.query.settingsTab) ? req.query.settingsTab : null;
    return res.render('main-admin-members', {
      title: 'Members',
      activeTab,
      settingsTab,
      templates: await membershipApprovals.getLetterTemplates(),
      handbookHtml: await membershipHandbook.getHandbookHtml(),
      handbookFile: await membershipHandbook.getHandbookFile(),
      paymentInfo: await membershipHandbook.getPaymentInfo(),
      accountingCategories: await listAccountingCategories(),
      parentFormFields: await membershipFormFields.listFields('parent'),
      childFormFields: await membershipFormFields.listFields('child'),
      generalFormFields: await membershipFormFields.listFields('general'),
      fieldTypes: membershipFormFields.FIELD_TYPES,
      // A real request: "Under member settings add a tab called grade
      // level settings. Here is a list of graded levels. Next to each
      // grade level is a date picker and another column for age... if
      // student is (age), by (date), then they will be in (grade
      // level)." One row per utils/classSchedule.js's own GRADE_LEVELS,
      // in that order - see utils/gradeLevelSettings.js.
      gradeLevelRules: await gradeLevelSettings.listGradeLevelRules(),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const showArchived = activeTab === 'archive';
  const q = (req.query.q || '').trim().toLowerCase();
  // A real request: "all filter buttons across the entire portal should
  // have member name dropdown, family dropdown, section dropdown with
  // check boxes, portal dropdown with check boxes, registered for
  // classes blank, yes, no" - four more filter dimensions alongside the
  // existing Type/Family: an exact member (memberIdFilter), any-of a set
  // of Sections, any-of a set of Portal roles, and whether the member has
  // at least one class enrollment on file at all (registeredFilter).
  const memberIdFilter = parseInt(req.query.memberId, 10) || null;
  const sectionFilter = [].concat(req.query.sectionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const roleFilter = [].concat(req.query.roleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const registeredFilter = ['yes', 'no'].includes(req.query.registered) ? req.query.registered : '';

  let withRosters = (await membersWithDetails(typeFilter, familyFilter))
    .filter((m) => (showArchived ? Number(m.active) === 0 : Number(m.active) === 1))
    .map((m) => ({ ...m, age: ageFromBirthday(m.birthday), birthdayLabel: m.birthday ? formatDateNumeric(m.birthday) : null }));
  if (q) withRosters = withRosters.filter((m) => m.name.toLowerCase().includes(q));
  if (memberIdFilter) withRosters = withRosters.filter((m) => m.id === memberIdFilter);
  if (sectionFilter.length > 0) {
    const sectionIdsByMember = await sectionIdsForMembers(withRosters.map((m) => m.id));
    withRosters = withRosters.filter((m) => sectionFilter.some((id) => (sectionIdsByMember[m.id] || new Set()).has(id)));
  }
  if (roleFilter.length > 0) {
    const portalStatusByMember = await portalStatusForMembers(withRosters.map((m) => m.id));
    withRosters = withRosters.filter((m) => roleFilter.some((id) => portalStatusByMember[m.id].roleIds.has(id)));
  }
  if (registeredFilter) {
    const enrolledRows = await db.prepare('SELECT DISTINCT student_id AS "studentId" FROM class_enrollments').all();
    const enrolledIds = new Set(enrolledRows.map((r) => r.studentId));
    withRosters = withRosters.filter((m) => (registeredFilter === 'yes' ? enrolledIds.has(m.id) : !enrolledIds.has(m.id)));
  }

  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  // A real bug report: "the dropdown for the last family on the page is
  // sometimes putting part of the family on the next page. Families
  // should stay together... each member list page doesn't have to be an
  // exact number of members" - see utils/pagination.js's own comment.
  const pagination = paginate(withRosters, parsePage(req.query.page), pageSize, memberFamilyGroupKey);

  // sections/roles also back the "Bulk Edit" dialog's own Add to
  // Section(s)/Portal(s) checkboxes (public/js/members-bulk-edit.js) -
  // sectionIdsByMember is still shown read-only on each row's own
  // subline below.
  const pageMemberIds = pagination.items.map((m) => m.id);
  const sections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const roles = await db.prepare('SELECT * FROM roles ORDER BY label').all();
  const sectionIdsByMember = await sectionIdsForMembers(pageMemberIds);
  // A real request: "add a lock icon on each member" - each row's own
  // Lock button (views/main-admin-members.ejs) needs to know whether
  // this member already has a portal account at all (nothing to lock
  // without one) and, if so, whether it's already locked ('suspended'),
  // to render correctly from a fresh page load, not just after a live
  // toggle (public/js/member-row-actions.js).
  const portalStatusByMember = await portalStatusForMembers(pageMemberIds);
  // Member Name dropdown (members-type-filter.ejs) - every member on
  // this same tab (active/archived), not just withRosters/the current
  // page, so picking a name the current filter already excludes is still
  // possible (same reasoning the Family dropdown above already follows).
  const allMemberNames = await db.prepare('SELECT id, name FROM members WHERE active = ? ORDER BY LOWER(name)').all(showArchived ? 0 : 1);

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
      (memberIdFilter ? `memberId=${memberIdFilter}&` : '') +
      sectionFilter.map((id) => `sectionIds=${id}&`).join('') +
      roleFilter.map((id) => `roleIds=${id}&`).join('') +
      (registeredFilter ? `registered=${registeredFilter}&` : '') +
      (q ? `q=${encodeURIComponent(q)}&` : ''),
    typeFilter,
    familyFilter,
    memberIdFilter,
    sectionFilter,
    roleFilter,
    registeredFilter,
    showArchived,
    q: req.query.q || '',
    families: await allFamilies(),
    allMemberNames,
    sections,
    roles,
    sectionIdsByMember,
    portalStatusByMember,
    avatarColorFor,
    error: req.query.error || null,
    notice: req.query.notice || null,
    smsMaxLength: smsProvider.MAX_SMS_LENGTH,
  });
});

// A real request: "all print button should show a print preview full
// real page on a page with a print button" - same dedicated <name>-print
// view + GET .../print route convention as views/admin-rosters-print.ejs,
// in place of the old onclick="window.print()" that just printed this
// page's own interactive card list as-is. Print only ever shows on the
// Members tab itself (see main-admin-members.ejs's own toolbar), so this
// always renders that tab's own filtered, unpaginated list - same
// Type/Family/search filters as the live page, never Archive/Approvals/
// Settings.
router.get('/print', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const q = (req.query.q || '').trim().toLowerCase();
  // A real request: "members, archive. add export, print and pdf icons" -
  // the Archive tab's own copies of these icons carry archived=1 so this
  // preview shows the ARCHIVED list, not the live one.
  const showArchived = req.query.archived === '1';

  let withRosters = (await membersWithDetails(typeFilter, familyFilter))
    .filter((m) => (showArchived ? Number(m.active) === 0 : Number(m.active) === 1))
    .map((m) => ({ ...m, age: ageFromBirthday(m.birthday), birthdayLabel: m.birthday ? formatDateNumeric(m.birthday) : null }));
  if (q) withRosters = withRosters.filter((m) => m.name.toLowerCase().includes(q));

  const sections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const sectionIdsByMember = await sectionIdsForMembers(withRosters.map((m) => m.id));

  res.render('main-admin-members-print', {
    title: showArchived ? 'Archive Print Preview' : 'Members Print Preview',
    members: withRosters,
    typeFilter,
    familyFilter,
    showArchived,
    q,
    families: await allFamilies(),
    sections,
    sectionIdsByMember,
    avatarColorFor,
  });
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - same filtered list as the print
// preview above, as a PDF. photoUrl is passed explicitly since
// renderViewToPdf renders through req.app.render(), which never sees
// this request's own res.locals (where server.js's own middleware
// normally puts it for every view).
router.get('/download.pdf', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const q = (req.query.q || '').trim().toLowerCase();
  const showArchived = req.query.archived === '1';

  let withRosters = (await membersWithDetails(typeFilter, familyFilter))
    .filter((m) => (showArchived ? Number(m.active) === 0 : Number(m.active) === 1))
    .map((m) => ({ ...m, age: ageFromBirthday(m.birthday), birthdayLabel: m.birthday ? formatDateNumeric(m.birthday) : null }));
  if (q) withRosters = withRosters.filter((m) => m.name.toLowerCase().includes(q));

  const sections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const sectionIdsByMember = await sectionIdsForMembers(withRosters.map((m) => m.id));

  const pdf = await renderViewToPdf(req, 'main-admin-members-print', {
    title: showArchived ? 'Archive Print Preview' : 'Members Print Preview',
    members: withRosters,
    typeFilter,
    familyFilter,
    showArchived,
    q,
    families: await allFamilies(),
    sections,
    sectionIdsByMember,
    avatarColorFor,
    photoUrl: res.locals.photoUrl,
  });
  sendPdf(res, `${showArchived ? 'archive' : 'members'}${typeFilter ? '-' + typeFilter : ''}.pdf`, pdf);
});

// A real request: "add member button, edit permissions button, edit,
// import, export buttons should be under the member tab above filter."
// Same export shape as routes/admin-members.js's own /members/export.csv,
// via the shared utils/memberImport.js.
router.get('/export.csv', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  // A real request: "members, archive. add export, print and pdf icons" -
  // the Archive tab's own copy carries archived=1 so this exports the
  // ARCHIVED list specifically, instead of the live/import-ready export
  // every member (active or not) below already defaults to.
  const showArchived = req.query.archived === '1';
  let members = await membersWithDetails(typeFilter, familyFilter);
  if (showArchived) members = members.filter((m) => Number(m.active) === 0);
  const lines = memberImport.buildMembersExportCsvLines(members);
  sendCsv(res, `${showArchived ? 'archive' : 'members'}${typeFilter ? '-' + typeFilter : ''}.csv`, lines);
});

// A real request: "Members. Locked. Should have the same icons and
// buttons formatted in the same rows as the archive page" - Export/
// Print/Download PDF icons matching Archive's own row, built against
// this list's own narrower shape (name/email, not the full member
// roster Archive's print preview is built for) rather than reusing
// main-admin-members-print.ejs.
async function lockedMembersList() {
  return db
    .prepare(
      `SELECT m.*, ma.id AS "accountId", ma.email AS "accountEmail" FROM members m
       JOIN member_accounts ma ON ma.member_id = m.id
       WHERE ma.status = 'suspended'
       ORDER BY LOWER(m.name)`
    )
    .all();
}

router.get('/locked/export.csv', async (req, res) => {
  const members = await lockedMembersList();
  const lines = [toCsvRow(['Name', 'Email']), ...members.map((m) => toCsvRow([m.name, m.accountEmail]))];
  sendCsv(res, 'locked.csv', lines);
});

router.get('/locked/print', async (req, res) => {
  res.render('main-admin-members-locked-print', { title: 'Locked Print Preview', members: await lockedMembersList() });
});

router.get('/locked/download.pdf', async (req, res) => {
  const pdf = await renderViewToPdf(req, 'main-admin-members-locked-print', { title: 'Locked Print Preview', members: await lockedMembersList() });
  sendPdf(res, 'locked.pdf', pdf);
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

// A real request: "make every member a user... give everyone the
// password changeme123. all members will have accounts." One-shot bulk
// bootstrap for every member who predates ensurePortalAccountForMember
// (utils/portalAuth.js - every NEW member gets an account automatically
// now, at creation time, in both portals' own New Member routes; this is
// only for retrofitting whoever was already in the system before that):
// creates a portal account (status 'active', so no separate approval
// step) for every ACTIVE member who doesn't already have one. A member
// with no email can't get one (member_accounts.email is required) -
// skipped, not silently dropped, so the admin sees exactly how many still
// need an email added before they can log in.
router.post('/bulk-create-accounts', async (req, res) => {
  const members = await db.prepare("SELECT id, email FROM members WHERE active = 1").all();
  const existingMemberIds = new Set((await db.prepare('SELECT member_id FROM member_accounts').all()).map((r) => r.member_id));

  let created = 0;
  let skippedNoEmail = 0;
  let skippedEmailInUse = 0;
  for (const m of members) {
    if (existingMemberIds.has(m.id)) continue;
    const result = await ensurePortalAccountForMember(m.id, m.email, req.portalAccount.id);
    if (result.status === 'created') created += 1;
    else if (result.status === 'no_email') skippedNoEmail += 1;
    else if (result.status === 'email_in_use') skippedEmailInUse += 1;
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
  if (kind !== 'approval' && kind !== 'denial') return res.redirect('/main-admin/members?tab=settings&settingsTab=approval-denial');
  if (!subject || !body) {
    return res.redirect('/main-admin/members?tab=settings&settingsTab=approval-denial&error=' + encodeURIComponent('Subject and body are both required.'));
  }
  await membershipApprovals.updateLetterTemplate(kind, subject, body);
  res.redirect('/main-admin/members?tab=settings&settingsTab=approval-denial&notice=' + encodeURIComponent(`${kind === 'approval' ? 'Approval' : 'Denial'} letter saved.`));
});

// A real request: "there should be a place at the bottom of the
// membership application to check a box after reading the policy
// handbook." What a family sees on the public form (views/portal-
// register.ejs) is admin-edited here.
router.post('/settings/handbook', async (req, res) => {
  await membershipHandbook.setHandbookHtml(sanitizePostBody(req.body.handbookHtml || ''));
  res.redirect('/main-admin/members?tab=settings&settingsTab=handbook&notice=' + encodeURIComponent('Policy Handbook saved.'));
});

// A real request: "add an option to upload the policy handbook as a
// document, pdf, etc." - an optional file alongside the rich-text
// handbook above (see utils/membershipHandbook.js's own comment on why
// this doesn't touch the existing scroll-to-read enforcement). Uploading
// a new file replaces whatever was there; deleteFile is a no-op if
// nothing was ever uploaded.
router.post('/settings/handbook/file', handbookFileUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.redirect('/main-admin/members?tab=settings&settingsTab=handbook&error=' + encodeURIComponent('Choose a PDF or Word file to upload.'));
  }
  const existing = await membershipHandbook.getHandbookFile();
  const client = createStorageClient();
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mimeType = DOCUMENT_MIME_BY_EXT[ext] || req.file.mimetype;
  let key;
  try {
    if (client) {
      key = await uploadFile(client, HANDBOOK_FILE_BUCKET, req.file.buffer, req.file.originalname, mimeType);
    } else {
      key = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(HANDBOOK_FILE_DIR, key), req.file.buffer);
    }
  } catch (err) {
    return res.redirect('/main-admin/members?tab=settings&settingsTab=handbook&error=' + encodeURIComponent(`Upload failed: ${err.message}`));
  }
  if (existing) {
    if (client) await deleteFile(client, HANDBOOK_FILE_BUCKET, existing.key).catch(() => {});
    else {
      const oldPath = path.join(HANDBOOK_FILE_DIR, existing.key);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  await membershipHandbook.setHandbookFile({ key, originalName: req.file.originalname, mimeType });
  res.redirect('/main-admin/members?tab=settings&settingsTab=handbook&notice=' + encodeURIComponent('Policy Handbook file uploaded.'));
});

router.post('/settings/handbook/file/delete', async (req, res) => {
  const existing = await membershipHandbook.getHandbookFile();
  if (existing) {
    const client = createStorageClient();
    if (client) await deleteFile(client, HANDBOOK_FILE_BUCKET, existing.key).catch(() => {});
    else {
      const oldPath = path.join(HANDBOOK_FILE_DIR, existing.key);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await membershipHandbook.setHandbookFile(null);
  }
  res.redirect('/main-admin/members?tab=settings&settingsTab=handbook&notice=' + encodeURIComponent('Policy Handbook file removed.'));
});

// A real request: "place at the bottom of the application for payment."
// Informational only, matching this app's existing payment convention
// (see utils/membershipHandbook.js's own comment) - no online charge is
// created from this form.
router.post('/settings/payment', async (req, res) => {
  const dollars = parseFloat(req.body.feeDollars || '0');
  const feeCents = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  const categoryId = req.body.categoryId ? Number(req.body.categoryId) : null;
  await membershipHandbook.setPaymentInfo(feeCents, (req.body.instructions || '').trim(), categoryId);
  res.redirect('/main-admin/members?tab=settings&settingsTab=fee-payment&notice=' + encodeURIComponent('Payment info saved.'));
});

// A real request: "under members in main admin portal there should be a
// settings tab for editing and adding parts of the membership form."
// target is 'parent', 'child', or 'general' - which repeatable block
// (Parent/Guardian vs Student) the new question shows up under, or
// (general) asked once per application instead - on both the admin-
// entered Membership Form/Add Member forms and the public self-
// registration application. A real request: "add a general field
// section."
router.post('/settings/membership-fields', async (req, res) => {
  const target = ['child', 'general'].includes(req.body.target) ? req.body.target : 'parent';
  const id = await membershipFormFields.createField(target, req.body.label, req.body.fieldType, req.body.options, req.body.isRequired === '1');
  if (!id) return res.redirect('/main-admin/members?tab=settings&settingsTab=form-fields&error=' + encodeURIComponent('A field label is required.'));
  res.redirect('/main-admin/members?tab=settings&settingsTab=form-fields&notice=' + encodeURIComponent('Field added.'));
});

router.post('/settings/membership-fields/:id/update', async (req, res) => {
  await membershipFormFields.updateField(parseInt(req.params.id, 10), req.body.label, req.body.fieldType, req.body.options, req.body.isRequired === '1');
  res.redirect('/main-admin/members?tab=settings&settingsTab=form-fields&notice=' + encodeURIComponent('Field saved.'));
});

router.post('/settings/membership-fields/:id/delete', async (req, res) => {
  await membershipFormFields.deleteField(parseInt(req.params.id, 10));
  res.redirect('/main-admin/members?tab=settings&settingsTab=form-fields&notice=' + encodeURIComponent('Field deleted.'));
});

// A real request: "Under member settings add a tab called grade level
// settings. Here is a list of graded levels. Next to each grade level is
// a date picker and another column for age... if student is (age), by
// (date), then they will be in (grade level)." One combined save for
// every row at once (parallel gradeLevel[]/age[]/cutoffDate[] arrays),
// same shape as the Membership Form Fields list above being a single
// list rather than one row = one request.
router.post('/settings/grade-levels', async (req, res) => {
  const gradeLevelList = [].concat(req.body.gradeLevel || []);
  const ageList = [].concat(req.body.age || []);
  const cutoffDateList = [].concat(req.body.cutoffDate || []);
  await gradeLevelSettings.saveGradeLevelRules(
    gradeLevelList.map((gradeLevel, i) => ({ gradeLevel, age: ageList[i], cutoffDate: cutoffDateList[i] }))
  );
  res.redirect('/main-admin/members?tab=settings&settingsTab=grade-levels&notice=' + encodeURIComponent('Grade Level Settings saved.'));
});

// A real follow-up request: "Grade level settings under members should
// set the grade level for all members according to their birthday" -
// applies the saved rules above to every student with a birthday on
// file (utils/gradeLevelSettings.js's own applyGradeLevelRulesToMembers),
// reporting back how many were actually changed vs. how many matched a
// rule but were already correct.
router.post('/settings/grade-levels/apply', async (req, res) => {
  const { totalStudents, matched, changed } = await gradeLevelSettings.applyGradeLevelRulesToMembers();
  const notice =
    matched === 0
      ? `No student's age matched a configured rule (checked ${totalStudents} student(s) with a birthday on file).`
      : `Updated ${changed} of ${matched} matching student(s)' grade level${changed === 1 ? '' : 's'} (${totalStudents} student(s) with a birthday on file checked in all).`;
  res.redirect('/main-admin/members?tab=settings&settingsTab=grade-levels&notice=' + encodeURIComponent(notice));
});

// --- Edit mode bulk actions (checkboxes + Actions dropdown on the
// Members tab) - a real request: "there should be an edit button on
// member page that says edit. when you click it it will show check
// boxes next to every member. you can select individusl, all or none, a
// dropdown also appears and says actions, delete or archive are the
// options." ---

// A real request: "any pages, do not refresh the page when clicking
// button or icons... stay on the screen so you don't have to search for
// families and members again." Mirrors routes/admin-members.js's own
// copy of this helper - these 2 bulk actions are still real page submits
// (public/js/members-bulk-actions.js), so they still redirect, but back
// to whatever Filter/Family/search/page querystring the Members tab
// actually had, not always the bare, unfiltered /main-admin/members.
// Only trusts a same-page Referer (pathname must actually be
// /main-admin/members) so a spoofed header can't send an admin somewhere
// unexpected.
function membersRedirectUrl(req, extraParams) {
  let url;
  try {
    const referer = new URL(req.get('Referer') || '');
    url = referer.pathname === '/main-admin/members' ? referer : new URL('http://x/main-admin/members');
  } catch {
    url = new URL('http://x/main-admin/members');
  }
  url.searchParams.delete('notice');
  url.searchParams.delete('error');
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  // encodeURIComponent, not URLSearchParams's own toString() (which
  // encodes a space as "+") - keeps the %20-style encoding every other
  // redirect in this file already uses.
  const query = [...url.searchParams].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return url.pathname + (query ? '?' + query : '');
}

router.post('/bulk-delete', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  for (const id of memberIds) await deleteMemberById(id);
  res.redirect(membersRedirectUrl(req, { notice: `Deleted ${memberIds.length} member(s).` }));
});

router.post('/bulk-archive', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => '?').join(',');
    await db.prepare(`UPDATE members SET active = 0, archived_at = now_text() WHERE id IN (${placeholders})`).run(...memberIds);
  }
  res.redirect(membersRedirectUrl(req, { notice: `Archived ${memberIds.length} member(s).` }));
});

// --- Bulk Edit (public/js/members-bulk-edit.js's own dialog) - "Main
// admin portal members bulk edit button allows you to select 1 or
// multiple members and add them to a section, portal, family, delete.
// Archive, text or email." Delete/Archive/Email/Text reuse what already
// existed (bulk-delete/bulk-archive above, and routes/main-admin-
// announcements.js's own /email/compose, /text/compose via
// utils/emailComposer.js's own resolveRecipients()) - these three are
// the new ones: add (never replace) the selected members to whichever
// section(s)/portal(s) were checked, or to one chosen family. ---

router.post('/bulk-add-sections', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const sectionIds = [].concat(req.body.sectionIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  for (const memberId of memberIds) await addMemberSections(memberId, sectionIds);
  res.redirect(membersRedirectUrl(req, { notice: `Added ${memberIds.length} member(s) to ${sectionIds.length} section(s).` }));
});

router.post('/bulk-add-roles', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const roleIds = [].concat(req.body.roleIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  let granted = 0;
  for (const memberId of memberIds) {
    if (await addMemberRoles(memberId, roleIds, req.portalAccount.id)) granted++;
  }
  const skipped = memberIds.length - granted;
  res.redirect(
    membersRedirectUrl(req, {
      notice: `Added ${roleIds.length} portal(s) to ${granted} member(s).${skipped > 0 ? ` ${skipped} skipped - no portal account.` : ''}`,
    })
  );
});

router.post('/bulk-add-family', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const familyId = parseInt(req.body.familyId, 10) || null;
  if (familyId && memberIds.length > 0) {
    const placeholders = memberIds.map(() => '?').join(',');
    await db.prepare(`UPDATE members SET family_id = ? WHERE id IN (${placeholders})`).run(familyId, ...memberIds);
  }
  res.redirect(membersRedirectUrl(req, { notice: `Added ${memberIds.length} member(s) to that family.` }));
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

// Same wantsJson branch as Co-op Admin's own /admin/members/families/
// :id/delete (routes/admin-members.js) - the Manage Families dialog's
// own Delete button (public/js/edit-families.js) fetches this so the
// family's row can just disappear from the still-open dialog, instead of
// a full page navigation closing the whole dialog out from under
// whoever's mid-cleanup.
router.post('/families/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  const family = await db.prepare('SELECT * FROM families WHERE id = ?').get(id);
  await db.prepare('DELETE FROM families WHERE id = ?').run(id);
  if (wantsJson) return res.json({ ok: true, id, name: family ? family.name : null });
  res.redirect('/main-admin/members?notice=' + encodeURIComponent(family ? `Deleted "${family.name}" family.` : 'Family deleted.'));
});

// --- Add / edit ---

// A real request: "No parent/student choice on membership forms or
// profiles. All children are automatically counted as student and adults
// counted as parents." Same derivation as routes/admin-members.js's own
// memberFormFields, now that the two portals' edit forms share
// partials/member-form-fields.ejs - see this file's own top comment.
function memberFormFields(req) {
  const birthday = (req.body.birthday || '').trim() || null;
  const memberType = req.body.memberType === 'admin' ? 'admin' : isChildAge(birthday) ? 'student' : 'parent';
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
    birthday,
    gradeLevel: memberType === 'student' ? (req.body.gradeLevel || '').trim() || null : null,
    medicalNotes: (req.body.medicalNotes || '').trim() || null,
    familyIdRaw: Number.isInteger(familyIdRaw) ? familyIdRaw : null,
    newFamilyName,
    isPrimaryParent: req.body.isPrimaryParent === '1',
    // A real request: "Remove setup/cleanup team section. That is only
    // done through the setup/cleanup admin pages" - this form no longer
    // touches setup_team_members at all.
    // req.body.adminPositionsFormPresent (a hidden marker, always
    // submitted alongside these checkboxes - see partials/member-form-
    // fields.ejs's own comment) distinguishes a real form save (resync to
    // exactly what's checked, however many that is) from a raw/partial
    // request that skips the form entirely (undefined here means "leave
    // existing positions untouched," never "clear them" - see
    // utils/adminPositions.js's own syncMemberAdminPositions).
    adminPositionIds:
      req.body.adminPositionsFormPresent === '1'
        ? [].concat(req.body.adminPositionIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
        : undefined,
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
    dayLabels: CLASS_DAY_LABELS_FULL,
    gradeLevels: GRADE_LEVELS,
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
    generalFields: await membershipFormFields.listFields('general'),
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

  // A real request: "parent/student should have an email and password
  // text box" - both optional, but a short password is rejected outright
  // (same 8-character floor the per-member Edit form's own Portal
  // Settings password box enforces) rather than silently truncated or
  // ignored, and setting one with no email to log in with makes no
  // sense. Checked for everyone before any member is actually created,
  // same "validate the whole family first" shape the parent/student
  // count checks just above already use.
  for (const p of parents) {
    if (p.password && p.password.length < 8) {
      return res.redirect(back + '?error=' + encodeURIComponent(`${p.name.trim()}'s password must be at least 8 characters.`));
    }
    if (p.password && !(p.email || '').trim()) {
      return res.redirect(back + '?error=' + encodeURIComponent(`An email address is required to set a password for ${p.name.trim()}.`));
    }
  }
  for (const c of children) {
    if (c.password && c.password.length < 8) {
      return res.redirect(back + '?error=' + encodeURIComponent(`${c.name.trim()}'s password must be at least 8 characters.`));
    }
    if (c.password && !(c.email || '').trim()) {
      return res.redirect(back + '?error=' + encodeURIComponent(`An email address is required to set a password for ${c.name.trim()}.`));
    }
  }

  const familyId = await resolveIntakeFamilyId({ familyId: body.familyId, newFamilyName: body.newFamilyName, homeschoolDuration: body.homeschoolDuration });

  let firstParentMemberId = null;
  for (const p of parents) {
    const parentMemberId = await createParentMember(familyId, address, {
      name: p.name.trim(),
      email: (p.email || '').trim() || null,
      password: p.password || null,
      phone: (p.phone || '').trim() || null,
      isPrimaryParent: p.isPrimaryParent === '1',
      cleanupTeamId: parseInt(p.cleanupTeamId, 10) || null,
      customFieldValues: p.customFields,
    }, req.portalAccount.id);
    if (firstParentMemberId == null) firstParentMemberId = parentMemberId;
  }
  // A real request: "add a general field section" - asked once per
  // application (see views/member-intake-form.ejs's own matching
  // comment), not once per parent/student, so its answers are recorded
  // against the first parent on the form rather than duplicated across
  // every family member.
  if (firstParentMemberId != null) {
    await membershipFormFields.saveFieldValues(firstParentMemberId, 'general', body.customFields);
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
        email: (c.email || '').trim() || null,
        password: c.password || null,
        customFieldValues: c.customFields,
      },
      photoFile,
      req.portalAccount.id
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
  res.render('admin-schedule-print', {
    title: 'Print Schedules',
    rows,
    activeDays: await listActiveClassDays(),
    dayLabels: CLASS_DAY_LABELS_FULL,
    compact: !!familyId,
  });
});

// A real request: "Add a button that says grade level report. When you
// click this page will show a bar bargraph members on every grade
// level. Also a grade level chart with names and ages in parenthesis.
// Column titles are grade levels." One column per GRADE_LEVELS entry (in
// that same order, same canonical list the Grade Level Settings tab and
// every class Age Group checkbox already share - see utils/
// gradeLevelSettings.js's own comment), plus a trailing "Ungraded"
// column for an active student with no grade_level set at all, but only
// when at least one actually needs it - unlike the real grade levels,
// showing an always-present 18th column for a state nobody's currently
// in would just be noise. Students only (not parents/admins) - a grade
// level is a student concept. Registered ahead of GET /:id below so
// "grade-level-report" is never swallowed as a member id, same reasoning
// schedule-print above already documents.
// A real follow-up request: "Add a filter for grade level report, orange
// button. Filter by section, schedule grid signup, family etc" - same
// roster-action-btn ("orange button" - every toolbar action button
// already uses that brand-colored class, nothing new to style) + Filter
// dialog shape the Member Schedules tab's own Filter popup already
// established (views/admin-schedule.ejs), GET params read back here and
// re-selected in the dialog on return. "Schedule grid signup" reads as a
// student's class_enrollments membership - the Classes grid's own
// student roster, not Grade Level Settings - so "Signed Up" here means
// "enrolled in at least one class," independent of which grade/semester.
async function gradeLevelReportStudents(req) {
  const sectionId = req.query.sectionId ? parseInt(req.query.sectionId, 10) : null;
  const signup = ['signedUp', 'notSignedUp'].includes(req.query.signup) ? req.query.signup : '';
  const familyId = req.query.familyId ? parseInt(req.query.familyId, 10) : null;

  let students = (await membersWithDetails('student'))
    .filter((m) => Number(m.active) === 1)
    .map((m) => ({ id: m.id, name: m.name, age: ageFromBirthday(m.birthday), gradeLevel: m.grade_level, familyId: m.family_id }));

  if (familyId) students = students.filter((s) => s.familyId === familyId);

  if (sectionId) {
    const sectionIdsByMember = await sectionIdsForMembers(students.map((s) => s.id));
    students = students.filter((s) => (sectionIdsByMember[s.id] || new Set()).has(sectionId));
  }

  if (signup) {
    const enrolledRows = await db.prepare('SELECT DISTINCT student_id AS "studentId" FROM class_enrollments').all();
    const enrolledIds = new Set(enrolledRows.map((r) => r.studentId));
    students = students.filter((s) => (signup === 'signedUp' ? enrolledIds.has(s.id) : !enrolledIds.has(s.id)));
  }

  return students.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// A real request: "all pages/subpages with print, export, import, or
// download buttons should be changed to icons... and have all four" -
// this page only had Print; same filtered student list as the report
// itself, one row per student, as a CSV.
router.get('/grade-level-report/export.csv', async (req, res) => {
  const students = await gradeLevelReportStudents(req);
  const lines = [toCsvRow(['Grade Level', 'Name', 'Age'])];
  students.forEach((s) => {
    lines.push(toCsvRow([s.gradeLevel || 'Ungraded', s.name, s.age ?? '']));
  });
  sendCsv(res, 'grade-level-report.csv', lines);
});

// Shared by the Grade Level Report page and its print-preview route below
// - both need the exact same filtered columns/maxCount/filterLabelParts.
async function gradeLevelReportData(req) {
  const sectionId = req.query.sectionId ? parseInt(req.query.sectionId, 10) : null;
  const signup = ['signedUp', 'notSignedUp'].includes(req.query.signup) ? req.query.signup : '';
  const familyId = req.query.familyId ? parseInt(req.query.familyId, 10) : null;
  const students = await gradeLevelReportStudents(req);

  const columns = GRADE_LEVELS.map((gradeLevel) => ({
    gradeLevel,
    students: students.filter((s) => s.gradeLevel === gradeLevel),
  }));
  const ungraded = students.filter((s) => !GRADE_LEVELS.includes(s.gradeLevel));
  if (ungraded.length > 0) columns.push({ gradeLevel: 'Ungraded', students: ungraded });

  const filterLabelParts = [];
  if (sectionId) {
    const section = await db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId);
    if (section) filterLabelParts.push(section.name);
  }
  if (signup) filterLabelParts.push(signup === 'signedUp' ? 'Signed Up' : 'Not Signed Up');
  if (familyId) {
    const family = await db.prepare('SELECT name FROM families WHERE id = ?').get(familyId);
    if (family) filterLabelParts.push(`${family.name} Family`);
  }

  return { sectionId, signup, familyId, columns, maxCount: Math.max(1, ...columns.map((c) => c.students.length)), filterLabelParts };
}

router.get('/grade-level-report', async (req, res) => {
  const { sectionId, signup, familyId, columns, maxCount, filterLabelParts } = await gradeLevelReportData(req);

  res.render('main-admin-members-grade-level-report', {
    title: 'Grade Level Report',
    columns,
    maxCount,
    sections: await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all(),
    families: await db.prepare('SELECT * FROM families ORDER BY LOWER(name)').all(),
    selectedSectionId: sectionId,
    selectedSignup: signup,
    selectedFamilyId: familyId,
    filterLabelParts,
  });
});

// A real request: "all print button should show a print preview full
// real page on a page with a print button" - same dedicated <name>-print
// view + GET .../print route convention as views/admin-rosters-print.ejs,
// in place of the old onclick="window.print()".
router.get('/grade-level-report/print', async (req, res) => {
  const { columns, maxCount, filterLabelParts } = await gradeLevelReportData(req);

  res.render('main-admin-members-grade-level-report-print', {
    title: 'Grade Level Report Print Preview',
    columns,
    maxCount,
    filterLabelParts,
  });
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - same gradeLevelReportData as the
// print preview above, as a PDF.
router.get('/grade-level-report/download.pdf', async (req, res) => {
  const { columns, maxCount, filterLabelParts } = await gradeLevelReportData(req);

  const pdf = await renderViewToPdf(req, 'main-admin-members-grade-level-report-print', {
    title: 'Grade Level Report Print Preview',
    columns,
    maxCount,
    filterLabelParts,
  });
  sendPdf(res, 'grade-level-report.pdf', pdf);
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
    schedule: await getMemberSchedule(id),
    dayLabels: CLASS_DAY_LABELS_FULL,
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
    history: attendanceFamilyAll ? null : groupAttendanceByRoster(formatAttendanceHistory(await attendanceHistoryForMember(id))),
    familyAttendanceHistories: attendanceFamilyAll
      ? await Promise.all(familyRoster.map(async (m) => ({ member: m, history: groupAttendanceByRoster(formatAttendanceHistory(await attendanceHistoryForMember(m.id))) })))
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
  // A real request: "when editing the parent member, and choosing
  // portals it will list each member in that family with a portal
  // dropdown next to it" - views/partials/member-portal-roles.ejs renders
  // one row per family member (self first) from this, each with its own
  // portal account/role state.
  const rolesFamilyRoster = [member, ...(await familyOf(id))];
  const rolesFamilyPortalStatus = await portalStatusForMembers(rolesFamilyRoster.map((m) => m.id));
  const familyPortalRows = rolesFamilyRoster.map((m) => ({
    member: m,
    portalAccount: rolesFamilyPortalStatus[m.id].account,
    roleIds: rolesFamilyPortalStatus[m.id].roleIds,
  }));

  res.render('main-admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    families: await allFamilies(),
    memberFamilyId: member.family_id,
    gradeLevels: GRADE_LEVELS,
    adminPositions: await listAdminPositions(),
    memberAdminPositionIds: await adminPositionIdsForMember(id),
    portalAccount: portalStatus.account,
    portalRoleIds: portalStatus.roleIds,
    allRoles: await db.prepare('SELECT * FROM roles ORDER BY label').all(),
    familyPortalRows,
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
    // A real request: "when you click edit profile for a member, it
    // should show the other parents and children's information as well
    // for easy editing." - see routes/admin-members.js's own identical
    // GET /members/:id/edit comment; this is the Main Admin copy of that
    // same inline "Family Members" editor.
    familyMembers: await familyOf(id),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// The inline "Family Members" editor's own per-row Save - see
// routes/admin-members.js's own identical route for the full comment on
// why this is deliberately a separate, narrower route from the full
// Add/Edit Member form above (POST /:id/edit).
router.post('/:viewerId/family/:memberId/quick-edit', async (req, res) => {
  const viewerId = parseInt(req.params.viewerId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  const back = `/main-admin/members/${viewerId}/edit`;

  const viewer = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(viewerId);
  const existing = await db.prepare('SELECT family_id, member_type FROM members WHERE id = ?').get(memberId);
  if (!viewer || !existing || viewer.family_id == null || existing.family_id !== viewer.family_id) {
    return res.redirect(back + '?error=' + encodeURIComponent('That family member could not be found.'));
  }

  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(back + '?error=' + encodeURIComponent('Name is required.'));
  const clash = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, memberId);
  if (clash) return res.redirect(back + '?error=' + encodeURIComponent(`"${name}" is already in the member list.`));

  const email = (req.body.email || '').trim() || null;
  const phone = (req.body.phone || '').trim() || null;
  const isStudent = existing.member_type === 'student';
  const birthdayRaw = (req.body.birthday || '').trim();
  const birthday = isStudent && isValidISODate(birthdayRaw) ? birthdayRaw : null;
  const gradeLevel = isStudent && GRADE_LEVELS.includes(req.body.gradeLevel) ? req.body.gradeLevel : null;

  if (isStudent) {
    await db.prepare('UPDATE members SET name = ?, email = ?, phone = ?, birthday = ?, grade_level = ? WHERE id = ?').run(name, email, phone, birthday, gradeLevel, memberId);
  } else {
    await db.prepare('UPDATE members SET name = ?, email = ?, phone = ? WHERE id = ?').run(name, email, phone, memberId);
  }

  res.redirect(back + '?notice=' + encodeURIComponent(`${name} updated.`));
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
// child in that submission. A further real request removed the explicit
// Student/Parent choice ("No parent/student choice on membership forms
// or profiles") - whether the new person is a parent or a student is
// derived from the Birthday they're given, same as the main Edit form.
router.post('/:id/quick-add-family-member', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const back = `/main-admin/members/${id}/edit`;
  const member = await db.prepare('SELECT family_id, address, city, state, zip FROM members WHERE id = ?').get(id);
  if (!member || member.family_id == null) return res.redirect(back + '?error=' + encodeURIComponent('This member has no family yet - choose or add one above and save first.'));

  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(back + '?error=' + encodeURIComponent('Name is required.'));
  const birthday = isValidISODate((req.body.birthday || '').trim()) ? req.body.birthday.trim() : null;
  const address = { address: member.address, city: member.city, state: member.state, zip: member.zip };

  if (isChildAge(birthday)) {
    const gradeLevel = GRADE_LEVELS.includes(req.body.gradeLevel) ? req.body.gradeLevel : null;
    await createChildMember(member.family_id, address, { name, birthday, gradeLevel, medicalNotes: null });
  } else {
    await createParentMember(member.family_id, address, { name, isPrimaryParent: false }, req.portalAccount.id);
  }

  res.redirect(back + '?notice=' + encodeURIComponent(`${name} added to the family.`));
});

router.post('/:id/edit', uploadMemberPhoto((req) => `/main-admin/members/${req.params.id}/edit`), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = memberFormFields(req);
  if (!f.name) return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent('Name is required.'));
  const clash = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND id != ?').get(f.name, id);
  if (clash) return res.redirect(`/main-admin/members/${id}/edit?error=` + encodeURIComponent(`"${f.name}" is already in the member list.`));
  const existing = await db.prepare('SELECT photo_path, member_type FROM members WHERE id = ?').get(id);
  // A real request: "There should not be admin check box on any of the
  // membership form or profiles... Admins will simply get a star."
  // member_type === 'admin' is derived purely from holding an Admin
  // Position (utils/adminPositions.js's own syncMemberAdminStatus) -
  // this form can no longer grant OR revoke it directly (same boundary
  // routes/admin-members.js's own POST /members/:id/edit already
  // enforces), for a raw request that skips the form entirely.
  if (existing && (f.memberType === 'admin') !== (existing.member_type === 'admin')) {
    f.memberType = existing.member_type;
    if (f.memberType !== 'admin') f.adminPositionIds = null;
  }
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

  // Portal Settings' role controls - see views/partials/member-portal-
  // roles.ejs. A student only ever submits their own roleIds_<id> field
  // (single Allow Student Portal checkbox); anyone else submits one for
  // every member of their family, since that view renders the whole
  // family's portal access in one place. setMemberRoles is already a
  // no-op for a member with no account (e.g. a sibling who has none yet),
  // so looping unconditionally is safe either way.
  const rolesFamilyIds = existing && existing.member_type === 'student' ? [id] : [id, ...(await familyOf(id)).map((fm) => fm.id)];
  for (const fmId of rolesFamilyIds) {
    const fmRoleIds = [].concat(req.body['roleIds_' + fmId] || []).map((v) => parseInt(v, 10)).filter(Boolean);
    await setMemberRoles(fmId, fmRoleIds, req.portalAccount.id);
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
  if (isFetch(req)) return res.json({ ok: true });
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

// A real request: "Add a text icon to click and a pop up appears
// allowing you type a text message, add an image and send text button
// and close button." Mirrors routes/admin-members.js's own identical
// /members/:id/text route exactly - see that route's own comment for
// the full reasoning (reuses the existing 'text_message' notification
// type Communication's own Text campaign feature already seeded, with
// the same no-portal-account phone fallback Floater/Setup's own text-
// notify routes use).
router.post('/:id/text', memberTextImageUpload.single('image'), async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT id, name, phone FROM members WHERE id = ?').get(memberId);
  if (!member) return res.status(404).json({ ok: false, error: 'Member not found.' });
  if (!member.phone) return res.status(400).json({ ok: false, error: 'This member has no phone on file.' });
  const body = (req.body.message || '').trim();
  if (!body) return res.status(400).json({ ok: false, error: 'A message is required.' });
  // A real request: "Set 160 character length for all texting features
  // across the app."
  if (body.length > smsProvider.MAX_SMS_LENGTH) return res.status(400).json({ ok: false, error: `That message is ${body.length} characters - texts are capped at ${smsProvider.MAX_SMS_LENGTH} characters.` });

  let mediaUrl = null;
  if (req.file) {
    const client = createStorageClient();
    const key = await saveUpload({
      client,
      bucket: MEMBER_TEXT_IMAGE_BUCKET,
      localDir: MEMBER_TEXT_IMAGE_DIR,
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
    });
    mediaUrl = urlForUpload({ client, bucket: MEMBER_TEXT_IMAGE_BUCKET, webDir: '/uploads/member-text-images', key });
  }

  const account = await db.prepare("SELECT id FROM member_accounts WHERE member_id = ? AND status = 'active'").get(memberId);
  let status;
  let detail;
  if (account) {
    const notificationId = await notify(account.id, 'text_message', { title: 'Text Message', body, mediaUrl });
    const delivery = await db.prepare("SELECT status, detail FROM notification_deliveries WHERE notification_id = ? AND channel = 'sms'").get(notificationId);
    status = delivery ? delivery.status : 'skipped';
    detail = delivery ? delivery.detail : null;
  } else {
    const result = await smsProvider.send(member.phone, body, mediaUrl);
    status = result.status;
    detail = result.detail;
  }

  res.json({ ok: true, status, detail });
});

router.post('/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE members SET active = 0, archived_at = now_text() WHERE id = ?').run(id);
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect('/main-admin/members?notice=' + encodeURIComponent('Member archived.'));
});

// A real request: "next to each members name under archive there
// should be a button that says reactivate to make them a member again
// and remove them from the archive list."
router.post('/:id/unarchive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE members SET active = 1, archived_at = NULL WHERE id = ?').run(id);
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect('/main-admin/members?tab=archive&notice=' + encodeURIComponent('Member reactivated.'));
});

// A real request: "add a lock icon on each member... be able to lock
// members and they won't be able to log in, unless to see and pay their
// account balance" - toggles member_accounts.status to/from 'suspended'
// (middleware/portalAuth.js's own requirePortalAuth confines that status
// to /accounting from here on). A member with no portal account at all
// has nothing to lock - there's no login to block - so this is a no-op
// error rather than silently creating one.
router.post('/:id/lock', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(id);
  if (!account) {
    if (isFetch(req)) return res.status(400).json({ ok: false, error: 'This member has no portal account to lock.' });
    return res.redirect('/main-admin/members?error=' + encodeURIComponent('This member has no portal account to lock.'));
  }
  await db.prepare("UPDATE member_accounts SET status = 'suspended' WHERE id = ?").run(account.id);
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect('/main-admin/members?notice=' + encodeURIComponent('Member locked.'));
});

router.post('/:id/unlock', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare("UPDATE member_accounts SET status = 'active' WHERE member_id = ? AND status = 'suspended'").run(id);
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect('/main-admin/members?tab=locked&notice=' + encodeURIComponent('Member unlocked.'));
});

module.exports = router;
