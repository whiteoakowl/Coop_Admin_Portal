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
const { easternInputToUtcText, formatTimestamp } = require('../utils/dates');

router.use(requirePortalAuth, requirePortal('main_admin'));

router.get('/', async (req, res) => {
  const pendingCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM member_accounts WHERE status = 'pending'").get()).c);
  const activeCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM member_accounts WHERE status = 'active'").get()).c);
  const roleCounts = await db
    .prepare(
      `SELECT r.label, COUNT(*) AS c FROM member_account_roles mar JOIN roles r ON r.id = mar.role_id GROUP BY r.label ORDER BY r.label`
    )
    .all();

  res.render('main-admin-home', {
    title: 'Main Admin',
    pendingCount,
    activeCount,
    roleCounts,
  });
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
  const announcements = await db.prepare('SELECT * FROM announcements ORDER BY published_at DESC').all();
  const faqs = await db.prepare('SELECT * FROM faqs ORDER BY position, id').all();
  res.render('main-admin-website', { title: 'Website', settings, announcements, faqs, notice: req.query.notice || null });
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

router.post('/website/announcements', requirePortalPermission('manage_website'), async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  if (!title || !body) return res.redirect('/main-admin/website?notice=' + encodeURIComponent('Title and body are required.'));
  await db
    .prepare('INSERT INTO announcements (title, body, is_public, created_by_account_id) VALUES (?, ?, ?, ?)')
    .run(title, body, req.body.isPublic === '1' ? 1 : 0, req.portalAccount.id);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Announcement posted.'));
});

router.post('/website/announcements/:id/delete', requirePortalPermission('manage_website'), async (req, res) => {
  await db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Announcement removed.'));
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

module.exports = router;
