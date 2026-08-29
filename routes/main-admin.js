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
const { hashPassword, findAccountByEmail } = require('../utils/portalAuth');
const { listWindows, createWindow, deleteWindow } = require('../utils/registrationWindows');
const { easternInputToUtcText, formatTimestamp, isValidISODate } = require('../utils/dates');
const { allDiplomas, issueDiploma } = require('../utils/academics');
const events = require('../utils/events');
const babysitters = require('../utils/babysitters');
const photos = require('../utils/photos');
const directory = require('../utils/directory');
const classifieds = require('../utils/classifieds');

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
// the gear icon (views/partials/portal-nav.ejs's settingsHref). This
// bare redirect gives that gear icon one stable URL to open - Users
// happens to be first since Users existed here before Website did.
router.get('/settings', requirePortalPermission('manage_users'), (req, res) => {
  res.redirect('/main-admin/users');
});

// A real request: "the co-op admin portal settings quicklinks tab
// should also appear under the settings gear on main admin as a tab."
// Open to any Main Admin account (no narrower requirePortalPermission
// gate) - same as Co-op Admin's own Quick Links tab, which every admin
// sees regardless of full-admin status (routes/admin.js's renderSettings).
router.get('/quick-links', (req, res) => {
  res.render('main-admin-quick-links', { title: 'Quick Links' });
});

// --- Users ---

router.get('/users', requirePortalPermission('manage_users'), async (req, res) => {
  const accounts = await db
    .prepare(
      `SELECT ma.id, ma.email, ma.status, ma.created_at, ma.last_login_at, m.name AS "memberName"
       FROM member_accounts ma JOIN members m ON m.id = ma.member_id
       ORDER BY ma.status = 'pending' DESC, LOWER(m.name)`
    )
    .all();
  const roleRows = await db
    .prepare(`SELECT mar.member_account_id AS "accountId", r.id, r.key, r.label FROM member_account_roles mar JOIN roles r ON r.id = mar.role_id`)
    .all();
  const rolesByAccount = {};
  const roleIdsByAccount = {};
  roleRows.forEach((r) => {
    if (!rolesByAccount[r.accountId]) rolesByAccount[r.accountId] = [];
    if (!roleIdsByAccount[r.accountId]) roleIdsByAccount[r.accountId] = [];
    rolesByAccount[r.accountId].push(r.label);
    roleIdsByAccount[r.accountId].push(r.id);
  });
  const allRoles = await db.prepare('SELECT id, key, label FROM roles ORDER BY label').all();

  res.render('main-admin-users', {
    title: 'Users',
    accounts: accounts.map((a) => ({ ...a, roleLabels: rolesByAccount[a.id] || [], roleIds: roleIdsByAccount[a.id] || [] })),
    allRoles,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/users/:id/roles', requirePortalPermission('manage_users'), async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const roleIds = [].concat(req.body.roleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);

  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM member_account_roles WHERE member_account_id = ?').run(accountId);
    for (const roleId of roleIds) {
      await tx
        .prepare('INSERT INTO member_account_roles (member_account_id, role_id, granted_by_account_id) VALUES (?, ?, ?)')
        .run(accountId, roleId, req.portalAccount.id);
    }
  });

  res.redirect('/main-admin/users?notice=' + encodeURIComponent('Roles updated.'));
});

router.post('/users/:id/approve', requirePortalPermission('manage_users'), async (req, res) => {
  await db
    .prepare("UPDATE member_accounts SET status = 'active', approved_at = now_text(), approved_by_account_id = ? WHERE id = ?")
    .run(req.portalAccount.id, req.params.id);
  res.redirect('/main-admin/users?notice=' + encodeURIComponent('Account approved.'));
});

router.post('/users/:id/suspend', requirePortalPermission('manage_users'), async (req, res) => {
  await db.prepare("UPDATE member_accounts SET status = 'suspended' WHERE id = ?").run(req.params.id);
  res.redirect('/main-admin/users?notice=' + encodeURIComponent('Account suspended.'));
});

router.post('/users/:id/reactivate', requirePortalPermission('manage_users'), async (req, res) => {
  await db.prepare("UPDATE member_accounts SET status = 'active' WHERE id = ?").run(req.params.id);
  res.redirect('/main-admin/users?notice=' + encodeURIComponent('Account reactivated.'));
});

// Admin-created accounts - the second signup path (alongside public
// self-registration): a Main Admin picks an EXISTING member (already in
// the system from the Members page/Membership Form) and issues them
// portal login credentials directly, active immediately - no approval
// queue, since a Main Admin is the one creating it.
router.get('/users/new', requirePortalPermission('manage_users'), async (req, res) => {
  const members = await db
    .prepare(
      `SELECT m.* FROM members m
       WHERE m.active = 1 AND NOT EXISTS (SELECT 1 FROM member_accounts ma WHERE ma.member_id = m.id)
       ORDER BY LOWER(m.name)`
    )
    .all();
  const allRoles = await db.prepare('SELECT id, key, label FROM roles ORDER BY label').all();
  res.render('main-admin-users-new', { title: 'Create Account', members, allRoles, error: req.query.error || null });
});

router.post('/users/new', requirePortalPermission('manage_users'), async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const roleIds = [].concat(req.body.roleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const back = '/main-admin/users/new';

  if (!memberId || !email || password.length < 8) {
    return res.redirect(back + '?error=' + encodeURIComponent('A member, email, and a password of at least 8 characters are required.'));
  }
  if (await findAccountByEmail(email)) {
    return res.redirect(back + '?error=' + encodeURIComponent('That email is already in use.'));
  }
  const alreadyHasAccount = await db.prepare('SELECT 1 FROM member_accounts WHERE member_id = ?').get(memberId);
  if (alreadyHasAccount) {
    return res.redirect(back + '?error=' + encodeURIComponent('That member already has an account.'));
  }

  await db.withTransaction(async (tx) => {
    const info = await tx
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at, approved_by_account_id) VALUES (?, ?, ?, 'active', now_text(), ?)")
      .run(memberId, email, hashPassword(password), req.portalAccount.id);
    for (const roleId of roleIds) {
      await tx.prepare('INSERT INTO member_account_roles (member_account_id, role_id, granted_by_account_id) VALUES (?, ?, ?)').run(info.lastInsertRowid, roleId, req.portalAccount.id);
    }
  });

  res.redirect('/main-admin/users?notice=' + encodeURIComponent('Account created.'));
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
  const faqs = await db.prepare('SELECT * FROM faqs ORDER BY position, id').all();
  res.render('main-admin-website', { title: 'Website', settings, faqs, notice: req.query.notice || null });
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

router.post('/website/faqs', requirePortalPermission('manage_website'), async (req, res) => {
  const question = (req.body.question || '').trim();
  const answer = (req.body.answer || '').trim();
  if (!question || !answer) return res.redirect('/main-admin/website?notice=' + encodeURIComponent('Question and answer are required.'));
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM faqs').get()).p) + 1;
  await db.prepare('INSERT INTO faqs (question, answer, position) VALUES (?, ?, ?)').run(question, answer, position);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('FAQ added.'));
});

router.post('/website/faqs/:id/delete', requirePortalPermission('manage_website'), async (req, res) => {
  await db.prepare('DELETE FROM faqs WHERE id = ?').run(req.params.id);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('FAQ removed.'));
});

// --- Registration Windows (staged, group-targeted class registration -
// see utils/registrationWindows.js's own header comment) ---

router.get('/registration-windows', requirePortalPermission('manage_classes'), async (req, res) => {
  const windowRows = await listWindows();
  const windows = windowRows.map((w) => ({ ...w, opensLabel: formatTimestamp(w.opens_at), closesLabel: formatTimestamp(w.closes_at) }));
  const roles = await db.prepare('SELECT key, label FROM roles ORDER BY label').all();
  res.render('main-admin-registration-windows', { title: 'Registration Windows', windows, roles, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/registration-windows', requirePortalPermission('manage_classes'), async (req, res) => {
  const label = (req.body.label || '').trim();
  const opensAt = easternInputToUtcText(req.body.opensAt);
  const closesAt = easternInputToUtcText(req.body.closesAt);
  const back = '/main-admin/registration-windows';
  if (!label || !opensAt) {
    return res.redirect(back + '?error=' + encodeURIComponent('A label and an opens-at date/time are required.'));
  }
  await createWindow({ label, roleKey: req.body.roleKey || null, opensAt, closesAt });
  res.redirect(back + '?notice=' + encodeURIComponent('Registration window added.'));
});

router.post('/registration-windows/:id/delete', requirePortalPermission('manage_classes'), async (req, res) => {
  await deleteWindow(req.params.id);
  res.redirect('/main-admin/registration-windows?notice=' + encodeURIComponent('Registration window removed.'));
});

// --- Diplomas (utils/academics.js) ---

router.get('/diplomas', requirePortalPermission('manage_academics'), async (req, res) => {
  const diplomas = await allDiplomas();
  const students = await db.prepare("SELECT id, name FROM members WHERE member_type = 'student' AND active = 1 ORDER BY LOWER(name)").all();
  res.render('main-admin-diplomas', { title: 'Diplomas', diplomas, students, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/diplomas', requirePortalPermission('manage_academics'), async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  const title = (req.body.title || '').trim() || 'Diploma of Completion';
  const issuedDate = req.body.issuedDate;
  const back = '/main-admin/diplomas';
  if (!studentId || !isValidISODate(issuedDate)) {
    return res.redirect(back + '?error=' + encodeURIComponent('A student and a valid issue date are required.'));
  }
  await issueDiploma({ studentId, title, issuedDate, bodyText: (req.body.bodyText || '').trim(), issuedByAccountId: req.portalAccount.id });
  res.redirect(back + '?notice=' + encodeURIComponent('Diploma issued.'));
});

module.exports = router;
