// Login/registration for the new member portal platform - see
// utils/portalAuth.js and middleware/portalAuth.js for the account/role
// model this drives. Completely separate from the single shared Admin
// login (routes/admin.js) and the kiosk's own no-login trust model.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { findAccountByEmail, verifyPassword, hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');
const { createFailureRateLimiter } = require('../utils/loginRateLimit');

const portalLoginLimiter = createFailureRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 8 });

// Only ever redirect back to a path within this app - same reasoning as
// routes/admin.js's own safeNext.
function safeNext(value) {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/portal';
}

router.get('/login', (req, res) => {
  if (req.portalAccount) return res.redirect(safeNext(req.query.next));
  res.render('portal-login', { title: 'Log In', error: null, notice: req.query.notice || null, next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const next = safeNext(req.body.next);
  if (portalLoginLimiter.isRateLimited(req.ip)) {
    return res.render('portal-login', { title: 'Log In', error: 'Too many login attempts. Please wait a few minutes and try again.', notice: null, next });
  }

  const email = (req.body.email || '').trim();
  const account = await findAccountByEmail(email);
  const passwordOk = account && (await verifyPassword(account, req.body.password));
  if (!account || !passwordOk) {
    portalLoginLimiter.recordFailure(req.ip);
    return res.render('portal-login', { title: 'Log In', error: 'Incorrect email or password.', notice: null, next });
  }
  portalLoginLimiter.recordSuccess(req.ip);

  if (account.status === 'pending') {
    return res.render('portal-login', {
      title: 'Log In',
      error: "Your registration is still awaiting admin approval. We'll email you once it's been reviewed.",
      notice: null,
      next,
    });
  }
  if (account.status === 'suspended') {
    return res.render('portal-login', { title: 'Log In', error: 'This account has been suspended. Please contact an administrator.', notice: null, next });
  }

  await db.prepare('UPDATE member_accounts SET last_login_at = now_text() WHERE id = ?').run(account.id);
  req.session.portalAccountId = account.id;
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  req.session.portalAccountId = null;
  res.redirect('/');
});

router.get('/register', (req, res) => {
  if (req.portalAccount) return res.redirect('/portal');
  res.render('portal-register', { title: 'Member Registration', error: null, formValues: {} });
});

// Self-registration creates a real member_accounts row with status
// 'pending' - it grants NO portal access on its own. A Main Admin must
// review and approve it (Main Admin Portal > Users), same trust model as
// the existing paper/admin-entered Membership Form this mirrors. If the
// email matches an existing member profile already in the system (e.g.
// someone the co-op already added by hand before self-service existed),
// the new login links to that same profile instead of creating a
// duplicate person.
router.post('/register', async (req, res) => {
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const formValues = { firstName, lastName, email };

  if (!firstName || !lastName || !email || !password) {
    return res.render('portal-register', { title: 'Member Registration', error: 'All fields are required.', formValues });
  }
  if (password.length < 8) {
    return res.render('portal-register', { title: 'Member Registration', error: 'Password must be at least 8 characters.', formValues });
  }
  if (password !== req.body.confirmPassword) {
    return res.render('portal-register', { title: 'Member Registration', error: 'Passwords do not match.', formValues });
  }
  if (await findAccountByEmail(email)) {
    return res.render('portal-register', { title: 'Member Registration', error: 'An account with that email already exists. Try logging in instead.', formValues });
  }

  const fullName = `${firstName} ${lastName}`;
  let member = await db.prepare('SELECT * FROM members WHERE LOWER(email) = LOWER(?) AND email IS NOT NULL').get(email);
  if (!member) {
    let familyName = lastName;
    let suffix = 2;
    while (await db.prepare('SELECT 1 FROM families WHERE LOWER(name) = LOWER(?)').get(familyName)) {
      familyName = `${lastName} (${suffix})`;
      suffix += 1;
    }
    const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
    const code = await generateMemberCode();
    const info = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, email, family_id, is_primary_parent) VALUES (?, ?, ?, 'parent', ?, ?, 1)")
      .run(fullName, code, code, email, familyId);
    member = await db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
  }

  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'pending')")
    .run(member.id, email, hashPassword(password));

  res.render('portal-register-submitted', { title: 'Registration Submitted' });
});

// The portal switcher - shows one card per portal (role) the account
// holds. Zero roles yet is a real, expected state right after
// registration (pending approval); exactly one role skips the picker
// entirely and goes straight in.
const PORTAL_HOME_ROUTES = {
  parent: '/parent',
  student: '/student',
  teacher: '/teacher',
  coop_admin: '/admin',
  main_admin: '/main-admin',
};

router.get('/portal', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal');
  const roles = req.portalRoles;
  if (roles.length === 1) return res.redirect(PORTAL_HOME_ROUTES[roles[0].key] || '/portal');
  res.render('portal-switcher', { title: 'My Portals', roles, portalHomeRoutes: PORTAL_HOME_ROUTES });
});

module.exports = router;
