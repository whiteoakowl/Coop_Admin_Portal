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
const { GRADE_OPTIONS } = require('../utils/membership');
const { isValidISODate } = require('../utils/dates');
const membershipHandbook = require('../utils/membershipHandbook');
const membershipFormFields = require('../utils/membershipFormFields');

const portalLoginLimiter = createFailureRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 8 });

// Only ever redirect back to a path within this app - same reasoning as
// routes/admin.js's own safeNext.
function safeNext(value) {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/portal';
}

router.get('/login', (req, res) => {
  if (req.portalAccount) return res.redirect(safeNext(req.query.next));
  res.render('portal-login', { title: 'Member Login', error: null, notice: req.query.notice || null, next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const next = safeNext(req.body.next);
  if (portalLoginLimiter.isRateLimited(req.ip)) {
    return res.render('portal-login', { title: 'Member Login', error: 'Too many login attempts. Please wait a few minutes and try again.', notice: null, next });
  }

  const email = (req.body.email || '').trim();
  const account = await findAccountByEmail(email);
  const passwordOk = account && (await verifyPassword(account, req.body.password));
  if (!account || !passwordOk) {
    portalLoginLimiter.recordFailure(req.ip);
    return res.render('portal-login', { title: 'Member Login', error: 'Incorrect email or password.', notice: null, next });
  }
  portalLoginLimiter.recordSuccess(req.ip);

  if (account.status === 'pending') {
    return res.render('portal-login', {
      title: 'Member Login',
      error: "Your registration is still awaiting admin approval. We'll email you once it's been reviewed.",
      notice: null,
      next,
    });
  }
  if (account.status === 'suspended') {
    return res.render('portal-login', { title: 'Member Login', error: 'This account has been suspended. Please contact an administrator.', notice: null, next });
  }

  await db.prepare('UPDATE member_accounts SET last_login_at = now_text() WHERE id = ?').run(account.id);
  req.session.portalAccountId = account.id;
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  req.session.portalAccountId = null;
  res.redirect('/');
});

router.get('/register', async (req, res) => {
  if (req.portalAccount) return res.redirect('/portal');
  res.render('portal-register', {
    title: 'Request Membership',
    error: null,
    formValues: {},
    children: [],
    gradeOptions: GRADE_OPTIONS,
    handbookHtml: await membershipHandbook.getHandbookHtml(),
    paymentInfo: await membershipHandbook.getPaymentInfo(),
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
  });
});

// multer isn't in play here (no file upload on this form), but the
// "children[0][firstName]"-style bracket fields still need pulling out
// of req.body into a real array the same way routes/membership.js's own
// parseChildren does for the admin-entered Membership Form - same
// bracket-naming convention, same reason (a removed block client-side
// can leave the array sparse).
function parseChildren(body) {
  if (Array.isArray(body.children)) return body.children;
  if (body.children && typeof body.children === 'object') {
    return Object.keys(body.children).map((k) => body.children[k]);
  }
  return [];
}

async function renderRegisterError(res, error, formValues, children) {
  return res.render('portal-register', {
    title: 'Request Membership',
    error,
    formValues,
    children,
    gradeOptions: GRADE_OPTIONS,
    handbookHtml: await membershipHandbook.getHandbookHtml(),
    paymentInfo: await membershipHandbook.getPaymentInfo(),
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
  });
}

// Self-registration creates a real member_accounts row with status
// 'pending' - it grants NO portal access on its own. A Main Admin must
// review and approve it (Main Admin Portal > Users), same trust model as
// the existing paper/admin-entered Membership Form this mirrors. If the
// email matches an existing member profile already in the system (e.g.
// someone the co-op already added by hand before self-service existed),
// the new login links to that same profile instead of creating a
// duplicate person.
//
// A real request: capture the family's children in this same submission
// (instead of a parent registering, then somehow separately getting each
// child added later) and, optionally per child, give that child their
// own portal login too - a family with kids old enough to want their own
// student-portal access shouldn't need a Main Admin to hand-create every
// one of those accounts one at a time (though a Main Admin still can,
// from Users > Create Account, for a member who didn't self-register).
router.post('/register', async (req, res) => {
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const formValues = { firstName, lastName, email, customFields: req.body.customFields };

  const rawChildren = parseChildren(req.body).map((c, index) => ({ ...c, index }));
  // A blank block the visitor never filled in (or removed down to zero
  // fields client-side) is dropped rather than rejected - children are
  // entirely optional on this form, unlike the admin Membership Form's
  // "at least one child" requirement.
  const children = rawChildren.filter((c) => c && ((c.firstName || '').trim() || (c.lastName || '').trim()));
  // What re-renders the form on a validation error - every submitted
  // block (even ones about to fail validation) so nothing the visitor
  // already typed gets lost, but never their password.
  const childrenForRerender = rawChildren.map((c) => ({ ...c, loginPassword: '', loginPasswordConfirm: '' }));

  if (!firstName || !lastName || !email || !password) {
    return renderRegisterError(res, 'All fields are required.', formValues, childrenForRerender);
  }
  if (password.length < 8) {
    return renderRegisterError(res, 'Password must be at least 8 characters.', formValues, childrenForRerender);
  }
  if (password !== req.body.confirmPassword) {
    return renderRegisterError(res, 'Passwords do not match.', formValues, childrenForRerender);
  }
  // A real request: "can't submit application without checking the
  // box" (having read the Policy Handbook). The checkbox itself is
  // disabled client-side until the visitor scrolls through the whole
  // handbook (public/js/portal-register-form.js) - checked again here
  // since a disabled attribute is only ever a client-side nicety.
  if (req.body.handbookRead !== '1') {
    return renderRegisterError(res, 'Please scroll through and confirm you have read the Policy Handbook before submitting.', formValues, childrenForRerender);
  }

  for (const c of children) {
    if (!(c.firstName || '').trim() || !(c.lastName || '').trim()) {
      return renderRegisterError(res, 'Each child needs both a first and last name.', formValues, childrenForRerender);
    }
    if (!c.wantsLogin) continue;
    const childEmail = (c.loginEmail || '').trim();
    const childPassword = c.loginPassword || '';
    if (!childEmail || !childPassword) {
      return renderRegisterError(res, `${c.firstName}'s portal login needs an email and password.`, formValues, childrenForRerender);
    }
    if (childPassword.length < 8) {
      return renderRegisterError(res, `${c.firstName}'s password must be at least 8 characters.`, formValues, childrenForRerender);
    }
    if (childPassword !== c.loginPasswordConfirm) {
      return renderRegisterError(res, `${c.firstName}'s passwords do not match.`, formValues, childrenForRerender);
    }
  }

  // Every login email this submission is about to create, checked for
  // collisions both against each other (two kids typing the same email)
  // and against every existing account - a family accidentally reusing
  // the parent's own email for a child's login is exactly the kind of
  // mistake this needs to catch before anything is written.
  const wantedEmails = [email, ...children.filter((c) => c.wantsLogin).map((c) => (c.loginEmail || '').trim())];
  const seen = new Set();
  for (const e of wantedEmails) {
    const key = e.toLowerCase();
    if (seen.has(key)) {
      return renderRegisterError(res, 'Each login on this form needs its own, different email address.', formValues, childrenForRerender);
    }
    seen.add(key);
  }
  for (const e of wantedEmails) {
    if (await findAccountByEmail(e)) {
      return renderRegisterError(res, `${e} is already in use by another account. Try logging in instead, or use a different email.`, formValues, childrenForRerender);
    }
  }

  const fullName = `${firstName} ${lastName}`;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();

  // Custom field answers (utils/membershipFormFields.js) are saved
  // AFTER the transaction below, via the module-level `db` connection -
  // not from inside it via `tx`, since PGlite's single-connection test
  // engine hangs on an outer-`db` query while a `tx` transaction on that
  // same connection is still open (see utils/members.js's own
  // generateMemberCode comment on this exact class of bug).
  let newParentMemberId = null;
  const newChildMemberIds = [];

  await db.withTransaction(async (tx) => {
    let member = await tx.prepare('SELECT * FROM members WHERE LOWER(email) = LOWER(?) AND email IS NOT NULL').get(email);
    let familyId = member ? member.family_id : null;
    if (!member) {
      let familyName = lastName;
      let suffix = 2;
      while (await tx.prepare('SELECT 1 FROM families WHERE LOWER(name) = LOWER(?)').get(familyName)) {
        familyName = `${lastName} (${suffix})`;
        suffix += 1;
      }
      familyId = (await tx.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
      const code = await generateMemberCode(tx);
      const info = await tx
        .prepare("INSERT INTO members (name, barcode, member_code, member_type, email, family_id, is_primary_parent) VALUES (?, ?, ?, 'parent', ?, ?, 1)")
        .run(fullName, code, code, email, familyId);
      member = await tx.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
    }
    newParentMemberId = member.id;

    const parentAccountInfo = await tx
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'pending')")
      .run(member.id, email, hashPassword(password));
    // The role is pre-granted now, not left for a Main Admin to remember
    // as a second step after approving - middleware/portalAuth.js's own
    // loadPortalSession only ever loads an 'active' account, so holding
    // a role while still 'pending' grants nothing until a Main Admin
    // actually approves it.
    if (parentRole) {
      await tx.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(parentAccountInfo.lastInsertRowid, parentRole.id);
    }

    for (const c of children) {
      const childCode = await generateMemberCode(tx);
      const childInfo = await tx
        .prepare(
          `INSERT INTO members (name, barcode, member_code, member_type, family_id, birthday, grade_level, medical_notes)
           VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`
        )
        .run(
          `${c.firstName.trim()} ${c.lastName.trim()}`,
          childCode,
          childCode,
          familyId,
          isValidISODate((c.birthdate || '').trim()) ? c.birthdate.trim() : null,
          GRADE_OPTIONS.includes(c.gradeLevel) ? c.gradeLevel : null,
          (c.medicalNotes || '').trim() || null
        );
      newChildMemberIds.push({ memberId: childInfo.lastInsertRowid, customFields: c.customFields });

      if (c.wantsLogin) {
        const childEmail = c.loginEmail.trim();
        const childAccountInfo = await tx
          .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'pending')")
          .run(childInfo.lastInsertRowid, childEmail, hashPassword(c.loginPassword));
        if (studentRole) {
          await tx.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(childAccountInfo.lastInsertRowid, studentRole.id);
        }
      }
    }
  });

  if (newParentMemberId != null) {
    await membershipFormFields.saveFieldValues(newParentMemberId, 'parent', req.body.customFields);
  }
  for (const child of newChildMemberIds) {
    await membershipFormFields.saveFieldValues(child.memberId, 'child', child.customFields);
  }

  res.render('portal-register-submitted', { title: 'Registration Submitted', childLoginCount: children.filter((c) => c.wantsLogin).length });
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

// Account-level settings (not tied to any one portal role) - reached via
// the gear icon every portal's own top bar now shows (partials/portal-
// nav.ejs). A real request: "my privacy on parent portal should be
// included in the gear settings button that should be on every portal."
// Just a links page today (My Privacy -> /member-directory/mine); a
// natural home for any future account-level setting (there's no self-
// service password change yet, for instance) without needing a new gear
// button added per portal each time.
router.get('/portal/settings', (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fsettings');
  res.render('portal-settings', { title: 'Settings' });
});

module.exports = router;
