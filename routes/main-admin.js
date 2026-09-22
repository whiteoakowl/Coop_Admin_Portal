// Main Admin Portal - the platform's own control center, distinct from
// both the single shared Admin login (routes/admin.js, still gates the
// existing Co-op Admin Portal unchanged) and every other new portal.
// Reachable only by an account holding the 'main_admin' role; individual
// sections additionally check a specific permission
// (middleware/portalAuth.js's requirePortalPermission) rather than just
// the role, so a future narrower role (e.g. "Website Editor") can be
// granted access to one section without every route needing a rewrite.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { isValidISODate } = require('../utils/dates');
const { allDiplomas, issueDiploma, allTranscriptEntries, addTranscriptEntry } = require('../utils/academics');
const { DAY_LABELS } = require('../utils/days');
const { GRADE_OPTIONS } = require('../utils/membership');
const events = require('../utils/events');
const babysitters = require('../utils/babysitters');
const photos = require('../utils/photos');
const directory = require('../utils/directory');
const classifieds = require('../utils/classifieds');
const {
  listAdminPositions,
  addAdminPosition,
  deleteAdminPosition,
  renameAdminPosition,
  permissionIdsForPosition,
  setPositionPermissions,
  addAdminPositionForMember,
  removeAdminPositionForMember,
  membersByAdminPosition,
} = require('../utils/adminPositions');
const { activeMemberOptions } = require('../utils/members');

router.use(requirePortalAuth, requirePortal('main_admin'));

// A real request: "should show a counter of how many families, how
// many parents and how many students." Same active-only convention
// routes/admin.js's own dashboard counters already use.
//
// Item 6 overhaul: "remove accounts by role counting, remove user
// settings [already gear-icon-only per the /settings redirect above] -
// there should be a count display for number of parents, students,
// families, teachers and admins. Then there should be a 2nd count
// display for pending requests such as events requests, babysitter
// approvals, photo submissions, business directory requests, classifieds
// request. Each name should be able to click and go straight to that
// request page." parents/students/families stay on the members table
// (unchanged, pre-existing counters); teachers/admins are portal ROLES
// (member_account_roles/roles), a different concept from members.
// member_type, since there's no 'teacher' member_type in the legacy
// Co-op Admin member model this table also serves.
router.get('/', async (req, res) => {
  const pendingCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM member_accounts WHERE status = 'pending'").get()).c);
  const activeCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM member_accounts WHERE status = 'active'").get()).c);
  const familyCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM families').get()).c);
  const parentCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = 'parent'").get()).c);
  const studentCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM members WHERE active = 1 AND member_type = 'student'").get()).c);
  const teacherCount = Number(
    (
      await db
        .prepare(
          `SELECT COUNT(DISTINCT mar.member_account_id) AS c FROM member_account_roles mar
           JOIN roles r ON r.id = mar.role_id JOIN member_accounts ma ON ma.id = mar.member_account_id
           WHERE r.key = 'teacher' AND ma.status = 'active'`
        )
        .get()
    ).c
  );
  const adminCount = Number(
    (
      await db
        .prepare(
          `SELECT COUNT(DISTINCT mar.member_account_id) AS c FROM member_account_roles mar
           JOIN roles r ON r.id = mar.role_id JOIN member_accounts ma ON ma.id = mar.member_account_id
           WHERE r.key IN ('coop_admin', 'main_admin') AND ma.status = 'active'`
        )
        .get()
    ).c
  );

  const eventRequestsCount = (await events.listEvents({ approvalStatus: 'pending' })).length;
  const babysitterApprovalsCount = (await babysitters.listPendingProfiles()).length;
  const photoSubmissionsCount = (await photos.listPendingPhotos()).length;
  const directoryRequestsCount = (await directory.listListings({ status: 'pending' })).length;
  const classifiedsRequestsCount = (await classifieds.listListings({ status: 'pending' })).length;

  res.render('main-admin-home', {
    title: 'Main Admin',
    pendingCount,
    activeCount,
    familyCount,
    parentCount,
    studentCount,
    teacherCount,
    adminCount,
    eventRequestsCount,
    babysitterApprovalsCount,
    photoSubmissionsCount,
    directoryRequestsCount,
    classifiedsRequestsCount,
  });
});

// A real request: "under main admin portal the users tab should be
// under the settings icon at the top as a file tab" - Users and Website
// (see /website below) both dropped out of the top-level nav (every
// views/main-admin-*.ejs's own navLinks array) and now live only under
// the gear icon (views/partials/portal-nav.ejs's settingsHref).
// Used to be a bare redirect straight to /main-admin/roles - a later
// real request: "clicking on the settings tab should not show subpages.
// instead all subpages should be rows of cards for each setting
// category" replaced that with a real landing page instead, one card per
// destination this gear used to either redirect to or list in its own
// dropdown (views/partials/portal-nav.ejs's old .portal-switcher-details
// menu, now gone in favor of a plain link straight here). No
// requirePortalPermission gate here, same as that old dropdown never
// filtered its own links by permission either - every card is shown,
// each destination page still enforces its own permission on click.
router.get('/settings', (req, res) => {
  res.render('main-admin-settings-hub', { title: 'Settings' });
});

// A real request: "the co-op admin portal settings quicklinks tab
// should also appear under the settings gear on main admin as a tab."
// Open to any Main Admin account (no narrower requirePortalPermission
// gate) - same as Co-op Admin's own Quick Links tab, which every admin
// sees regardless of full-admin status (routes/admin.js's renderSettings).
router.get('/quick-links', (req, res) => {
  res.render('main-admin-quick-links', { title: 'Quick Links' });
});

// --- Admins (moved from Co-op Admin's own Settings > Admins tab - a
// real request: "co-op admin portal. settings gear, admins tab. this
// tab should be located under the main admin portal settings gear as a
// tab. it should not be on co-op admin portal.") ---

// A real request: "one blue button that says add/edit admin position and
// one for printing the admin roster list... you can click on each admin
// position in the list and it will open an edit window. Here you can add
// a member from the drop down list. Add email address, add phone number.
// Then the roles and permissions are listed below... Admin list grid
// show admin position, admin name, phone, email, trash can." rows is one
// entry per (position, member) pair - a position with several leaders
// (the old "Add Leaders" dialog was additive, several people can share
// one title) gets one row per leader; a position with no one assigned
// yet still gets its own single row (member: null) so it stays visible
// and manageable. permissions/positionPermissionIds power each
// position's own "roles and permissions" checkbox grid - confirmed with
// the requester that a permission belongs to the POSITION itself (every
// current and future holder shares it), same shape
// routes/main-admin.js's own POST /roles/:id/permissions already uses
// for role_permissions, just scoped to an admin_position instead.
async function renderAdmins(req, res, error, notice) {
  const adminPositions = await listAdminPositions();
  const leadersByPosition = await membersByAdminPosition();
  const permissions = await db.prepare('SELECT * FROM permissions ORDER BY label').all();
  const positionPermissionIds = {};
  for (const p of adminPositions) positionPermissionIds[p.id] = await permissionIdsForPosition(p.id);

  const rows = [];
  for (const p of adminPositions) {
    const leaders = leadersByPosition[p.id] || [];
    if (leaders.length === 0) rows.push({ position: p, member: null });
    else for (const leader of leaders) rows.push({ position: p, member: leader });
  }

  res.render('main-admin-admins', {
    title: 'Admins',
    adminPositions,
    rows,
    permissions,
    positionPermissionIds,
    memberOptions: await activeMemberOptions(),
    error,
    notice,
  });
}

router.get('/admins', requirePortalPermission('manage_users'), async (req, res) => {
  await renderAdmins(req, res, req.query.error || null, req.query.notice || null);
});

// "Add/Edit Admin Position" button - one popup listing every existing
// position with its own rename input + delete, plus a "new position"
// field at the bottom, one Save for all of it - same shape Shop's own
// Add/Edit Category popup already uses (routes/admin-store.js's own
// POST /categories/bulk-save).
router.post('/admins/positions/bulk-save', requirePortalPermission('manage_users'), async (req, res) => {
  const ids = [].concat(req.body.positionId || []);
  const titles = [].concat(req.body.positionTitle || []);
  for (let i = 0; i < ids.length; i++) {
    const renamedTitle = (titles[i] || '').trim();
    if (renamedTitle) await renameAdminPosition(parseInt(ids[i], 10), renamedTitle);
  }
  const newTitle = (req.body.newPositionTitle || '').trim();
  if (newTitle) await addAdminPosition(newTitle);
  await renderAdmins(req, res, null, 'Positions saved.');
});

router.post('/admins/positions/:id/delete', requirePortalPermission('manage_users'), async (req, res) => {
  await deleteAdminPosition(parseInt(req.params.id, 10));
  await renderAdmins(req, res, null, 'Position removed.');
});

// Each admin position's own edit window. A chosen member is ADDED (same
// additive "never replaces whoever else already holds this position"
// behavior the old Add Leaders dialog had) - re-selecting someone who
// already holds it is a harmless no-op, letting this same dropdown also
// double as "update this existing leader's contact info" without a
// separate control. Permissions replace the position's whole set.
router.post('/admins/positions/:id/update', requirePortalPermission('manage_users'), async (req, res) => {
  const positionId = parseInt(req.params.id, 10);
  const permissionIds = [].concat(req.body.permissionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await setPositionPermissions(positionId, permissionIds);

  const memberId = req.body.memberId ? parseInt(req.body.memberId, 10) : null;
  if (memberId) {
    await addAdminPositionForMember(memberId, positionId);
    const email = (req.body.email || '').trim();
    const phone = (req.body.phone || '').trim();
    await db.prepare('UPDATE members SET email = ?, phone = ? WHERE id = ?').run(email || null, phone || null, memberId);
  }

  await renderAdmins(req, res, null, 'Saved.');
});

router.post('/admins/positions/:positionId/members/:memberId/remove', requirePortalPermission('manage_users'), async (req, res) => {
  await removeAdminPositionForMember(parseInt(req.params.memberId, 10), parseInt(req.params.positionId, 10));
  await renderAdmins(req, res, null, 'Leader removed.');
});

// --- Roles & Permissions (read-focused for this pass - see each role's
// permission checkboxes for the one mutation this screen supports) ---

router.get('/roles', requirePortalPermission('manage_roles'), async (req, res) => {
  const roles = await db.prepare('SELECT * FROM roles ORDER BY label').all();
  const permissions = await db.prepare('SELECT * FROM permissions ORDER BY label').all();
  const grants = await db.prepare('SELECT role_id, permission_id FROM role_permissions').all();
  const grantedKey = new Set(grants.map((g) => `${g.role_id}:${g.permission_id}`));

  res.render('main-admin-roles', { title: 'Roles & Permissions', roles, permissions, grantedKey: [...grantedKey], notice: req.query.notice || null });
});

router.post('/roles/:id/permissions', requirePortalPermission('manage_roles'), async (req, res) => {
  const roleId = parseInt(req.params.id, 10);
  const permissionIds = [].concat(req.body.permissionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);

  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    for (const permissionId of permissionIds) {
      await tx.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(roleId, permissionId);
    }
  });

  res.redirect('/main-admin/roles?notice=' + encodeURIComponent('Permissions updated.'));
});

// --- Website content ---

router.get('/website', requirePortalPermission('manage_website'), async (req, res) => {
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('main-admin-website', { title: 'Website', settings, notice: req.query.notice || null });
});

router.post('/website/settings', requirePortalPermission('manage_website'), async (req, res) => {
  const fields = ['org_name', 'tagline', 'hero_heading', 'hero_body', 'meeting_schedule_text', 'about_body', 'benefits_body', 'contact_email', 'contact_phone'];
  const values = fields.map((f) => (req.body[f] || '').trim());
  await db
    .prepare(
      `UPDATE site_settings SET org_name = ?, tagline = ?, hero_heading = ?, hero_body = ?, meeting_schedule_text = ?, about_body = ?, benefits_body = ?, contact_email = ?, contact_phone = ?, updated_at = now_text() WHERE id = 1`
    )
    .run(...values);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Website settings saved.'));
});

// Public homepage announcements are now created from the Announcements
// tab itself (routes/main-admin-announcements.js's roleKey === 'public'
// branch) - a real request: "the public home page announcements should
// be listed under the announcements tab." The delete route stays here
// (unchanged URL) since that's what the relocated list's own delete
// forms on that page still post to - only the CREATE form/route moved.
router.post('/website/announcements/:id/delete', requirePortalPermission('manage_website'), async (req, res) => {
  await db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.redirect('/main-admin/announcements?notice=' + encodeURIComponent('Announcement removed.'));
});

// --- FAQ (moved off the Website page onto its own Settings tab - a real
// request: "faq should be it's own tab under settings, not under website
// tab.") ---

router.get('/faq', requirePortalPermission('manage_website'), async (req, res) => {
  const faqs = await db.prepare('SELECT * FROM faqs ORDER BY position, id').all();
  res.render('main-admin-faq', { title: 'FAQ', faqs, notice: req.query.notice || null });
});

router.post('/faq/add', requirePortalPermission('manage_website'), async (req, res) => {
  const question = (req.body.question || '').trim();
  const answer = (req.body.answer || '').trim();
  if (!question || !answer) return res.redirect('/main-admin/faq?notice=' + encodeURIComponent('Question and answer are required.'));
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM faqs').get()).p) + 1;
  await db.prepare('INSERT INTO faqs (question, answer, position) VALUES (?, ?, ?)').run(question, answer, position);
  res.redirect('/main-admin/faq?notice=' + encodeURIComponent('FAQ added.'));
});

router.post('/faq/:id/delete', requirePortalPermission('manage_website'), async (req, res) => {
  await db.prepare('DELETE FROM faqs WHERE id = ?').run(req.params.id);
  res.redirect('/main-admin/faq?notice=' + encodeURIComponent('FAQ removed.'));
});

// --- Academics: diplomas + transcripts (utils/academics.js) ---
// One combined page (nav tab: "Academics") - a Main Admin issues
// diplomas here, and can also hand-add a past term to a student's
// transcript for history that predates this feature or a transfer
// student's prior co-op record (see student_academic_history's own
// migration comment: normally archiveClasses is the only writer).

router.get('/academics', requirePortalPermission('manage_academics'), async (req, res) => {
  const diplomas = await allDiplomas();
  const transcriptEntries = await allTranscriptEntries();
  const students = await db.prepare("SELECT id, name FROM members WHERE member_type = 'student' AND active = 1 ORDER BY LOWER(name)").all();
  res.render('main-admin-academics', {
    title: 'Academics',
    diplomas,
    transcriptEntries,
    students,
    dayLabels: DAY_LABELS,
    gradeOptions: GRADE_OPTIONS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/academics/diploma', requirePortalPermission('manage_academics'), async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  const title = (req.body.title || '').trim() || 'Diploma of Completion';
  const issuedDate = req.body.issuedDate;
  const back = '/main-admin/academics';
  if (!studentId || !isValidISODate(issuedDate)) {
    return res.redirect(back + '?error=' + encodeURIComponent('A student and a valid issue date are required.'));
  }
  await issueDiploma({ studentId, title, issuedDate, bodyText: (req.body.bodyText || '').trim(), issuedByAccountId: req.portalAccount.id });
  res.redirect(back + '?notice=' + encodeURIComponent('Diploma issued.'));
});

router.post('/academics/transcript', requirePortalPermission('manage_academics'), async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  const className = (req.body.className || '').trim();
  const termEndedAt = req.body.termEndedAt;
  const back = '/main-admin/academics';
  if (!studentId || !className || !isValidISODate(termEndedAt)) {
    return res.redirect(back + '?error=' + encodeURIComponent('A student, class name, and a valid term-ended date are required.'));
  }
  await addTranscriptEntry({
    studentId,
    className,
    day: req.body.day || null,
    ageGroup: req.body.ageGroup || null,
    teacherNames: (req.body.teacherNames || '').trim(),
    termEndedAt,
  });
  res.redirect(back + '?notice=' + encodeURIComponent('Transcript entry added.'));
});

module.exports = router;
