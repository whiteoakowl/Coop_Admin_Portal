// Login/registration for the new member portal platform - see
// utils/portalAuth.js and middleware/portalAuth.js for the account/role
// model this drives. Completely separate from the single shared Admin
// login (routes/admin.js) and the kiosk's own no-login trust model.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { findAccountByEmail, verifyPassword, hashPassword, memberForAccount, familyForAccount } = require('../utils/portalAuth');
const { generateMemberCode, setPrimaryParent } = require('../utils/members');
const { savePhotoFile: saveMemberPhotoFile, deletePhotoFile: deleteMemberPhotoFile } = require('../utils/memberPhoto');
const { createFailureRateLimiter } = require('../utils/loginRateLimit');
const { GRADE_OPTIONS } = require('../utils/membership');
const { CLASS_DAY_LABELS_FULL } = require('../utils/classSchedule');
const { CLASS_DAYS } = require('../utils/classDays');
const { isValidISODate, formatDateLongNoWeekday } = require('../utils/dates');
const { portalStatusForMembers, sectionIdsForMembers } = require('../utils/portalPermissions');
const membershipHandbook = require('../utils/membershipHandbook');
const membershipFormFields = require('../utils/membershipFormFields');
const path = require('path');
const fs = require('fs');
const { createStorageClient, downloadFile } = require('../utils/storage');
const { uploadIntakePhotos, savePhotoFile, parseArrayField } = require('../utils/memberIntake');
const { familyEditSections, applyFamilyEditSubmission } = require('../utils/memberFamilyEdit');

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
  await db.prepare('UPDATE member_accounts SET last_login_at = now_text() WHERE id = ?').run(account.id);
  req.session.portalAccountId = account.id;
  // A real request: "be able to lock members and they won't be able to
  // log in, unless to see and pay their account balance" - a 'suspended'
  // (Locked) account now DOES get a session (middleware/portalAuth.js's
  // own requirePortalAuth confines it to /accounting from there), rather
  // than being blocked at login outright the way it used to be.
  res.redirect(account.status === 'suspended' ? '/accounting?locked=1' : next);
});

router.post('/logout', (req, res) => {
  req.session.portalAccountId = null;
  res.redirect('/');
});

// A real request: "add an option to upload the policy handbook as a
// document, pdf, etc." - genuinely public (no login), same reasoning as
// routes/documents.js's own public /documents/:token/file: a prospective
// family reading the handbook on /register isn't signed in yet.
const HANDBOOK_FILE_BUCKET = 'documents';
const HANDBOOK_FILE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');
router.get('/handbook-file', async (req, res) => {
  const file = await membershipHandbook.getHandbookFile();
  if (!file) return res.status(404).send('Not found');
  const client = createStorageClient();
  let buffer;
  if (client) {
    try {
      buffer = await downloadFile(client, HANDBOOK_FILE_BUCKET, file.key);
    } catch {
      return res.status(404).send('Not found');
    }
  } else {
    const filePath = path.join(HANDBOOK_FILE_DIR, file.key);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    buffer = fs.readFileSync(filePath);
  }
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${file.originalName.replace(/"/g, '')}"`);
  res.send(buffer);
});

// 10DLC compliance - a real Telnyx campaign review rejection: "no privacy
// policy link was provided... /privacy and /privacy-policy return 404,
// and no privacy verbiage exists on any reachable page of the portal."
// Public (no login), same reasoning as /handbook-file above - linked
// from the SMS opt-in checkbox on /register, which is itself public.
router.get('/privacy-policy', (req, res) => {
  res.render('portal-privacy-policy', { title: 'Privacy Policy', lastUpdated: new Date().toISOString().slice(0, 10) });
});

// 10DLC compliance - Telnyx's own compliance guide: "Privacy Policy and
// Terms links should be included in the registration, and Terms must be
// a link or on-page text rather than a pop-up." Public (no login), same
// reasoning as /privacy-policy above.
router.get('/terms-and-conditions', (req, res) => {
  res.render('portal-terms', { title: 'Terms and Conditions', lastUpdated: new Date().toISOString().slice(0, 10) });
});

// A real request: the "Request Membership Form" quick link under Main
// Admin's own Settings hub always bounced straight to the portal picker
// instead of showing the form, since a Main Admin is necessarily logged
// in - the real "already logged in, don't let someone re-register"
// protection below is still exactly right for every other already-
// registered account (a parent/student/teacher clicking a stale
// bookmark), just not for Main Admin previewing/screenshotting this
// public page (e.g. for a Telnyx 10DLC campaign submission).
function isMainAdmin(req) {
  return (req.portalRoles || []).some((r) => r.key === 'main_admin');
}

router.get('/register', async (req, res) => {
  if (req.portalAccount && !isMainAdmin(req)) return res.redirect('/portal');
  res.render('portal-register', {
    title: 'Request Membership',
    error: null,
    formValues: {},
    children: [],
    additionalParents: [],
    handbookHtml: await membershipHandbook.getHandbookHtml(),
    handbookFile: await membershipHandbook.getHandbookFile(),
    paymentInfo: await membershipHandbook.getPaymentInfo(),
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
    generalFields: await membershipFormFields.listFields('general'),
  });
});

async function renderRegisterError(res, error, formValues, children, additionalParents) {
  return res.render('portal-register', {
    title: 'Request Membership',
    error,
    formValues,
    children,
    additionalParents,
    handbookHtml: await membershipHandbook.getHandbookHtml(),
    handbookFile: await membershipHandbook.getHandbookFile(),
    paymentInfo: await membershipHandbook.getPaymentInfo(),
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
    generalFields: await membershipFormFields.listFields('general'),
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
router.post('/register', uploadIntakePhotos('/register'), async (req, res) => {
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();
  const email = (req.body.email || '').trim();
  const phone = (req.body.phone || '').trim();
  const smsOptIn = req.body.smsOptIn === '1';
  const password = req.body.password || '';
  // "Under first parent/guardian it should have address 1, address 2,
  // city, state, zip code."
  const address = (req.body.address || '').trim();
  const address2 = (req.body.address2 || '').trim();
  const city = (req.body.city || '').trim();
  const state = (req.body.state || '').trim();
  const zip = (req.body.zip || '').trim();
  const formValues = { firstName, lastName, email, phone, address, address2, city, state, zip, customFields: req.body.customFields };

  const rawChildren = parseArrayField(req.body, 'children').map((c, index) => ({ ...c, index }));
  // A blank block the visitor never filled in (or removed down to zero
  // fields client-side) is dropped rather than rejected - children are
  // entirely optional on this form, unlike the admin Membership Form's
  // "at least one child" requirement.
  const children = rawChildren.filter((c) => c && ((c.firstName || '').trim() || (c.lastName || '').trim()));
  // What re-renders the form on a validation error - every submitted
  // block (even ones about to fail validation) so nothing the visitor
  // already typed gets lost, but never their password.
  const childrenForRerender = rawChildren.map((c) => ({ ...c, loginPassword: '', loginPasswordConfirm: '' }));

  // "There is a +child button. There should also be an add adult
  // button." Same optional, drop-if-blank treatment as a child block. A
  // later real request ("add check box for give this parent their own
  // portal log in") gave each additional adult the same wantsLogin
  // toggle a child block already had - see partials/register-adult-
  // fields.ejs's own header comment for why there's no separate login-
  // email field here (the Email field already in that same block is
  // reused as the login email).
  const rawAdults = parseArrayField(req.body, 'additionalParents').map((a, index) => ({ ...a, index }));
  const additionalParents = rawAdults.filter((a) => a && ((a.firstName || '').trim() || (a.lastName || '').trim()));
  // Same never-echo-the-password treatment as childrenForRerender above.
  const adultsForRerender = rawAdults.map((a) => ({ ...a, loginPassword: '', loginPasswordConfirm: '' }));

  if (!firstName || !lastName || !email || !password) {
    return renderRegisterError(res, 'All fields are required.', formValues, childrenForRerender, adultsForRerender);
  }
  if (password.length < 8) {
    return renderRegisterError(res, 'Password must be at least 8 characters.', formValues, childrenForRerender, adultsForRerender);
  }
  if (password !== req.body.confirmPassword) {
    return renderRegisterError(res, 'Passwords do not match.', formValues, childrenForRerender, adultsForRerender);
  }
  // A real request: "can't submit application without checking the
  // box" (having read the Policy Handbook). The checkbox itself is
  // disabled client-side until the visitor scrolls through the whole
  // handbook (public/js/portal-register-form.js) - checked again here
  // since a disabled attribute is only ever a client-side nicety.
  if (req.body.handbookRead !== '1') {
    return renderRegisterError(res, 'Please scroll through and confirm you have read the Policy Handbook before submitting.', formValues, childrenForRerender, adultsForRerender);
  }
  // A real request: "Next section. Privacy Policy with a check box, next
  // row terms and conditions with checkbox" - two more required
  // agreements, same re-check-server-side-since-a-checkbox-is-only-ever-
  // a-client-side-nicety reasoning as handbookRead above.
  if (req.body.privacyPolicyRead !== '1') {
    return renderRegisterError(res, 'Please check the box confirming you have read the Privacy Policy before submitting.', formValues, childrenForRerender, adultsForRerender);
  }
  if (req.body.termsRead !== '1') {
    return renderRegisterError(res, 'Please check the box confirming you have read the Terms and Conditions before submitting.', formValues, childrenForRerender, adultsForRerender);
  }

  for (const c of children) {
    if (!(c.firstName || '').trim() || !(c.lastName || '').trim()) {
      return renderRegisterError(res, 'Each child needs both a first and last name.', formValues, childrenForRerender, adultsForRerender);
    }
    if (!c.wantsLogin) continue;
    const childEmail = (c.loginEmail || '').trim();
    const childPassword = c.loginPassword || '';
    if (!childEmail || !childPassword) {
      return renderRegisterError(res, `${c.firstName}'s portal login needs an email and password.`, formValues, childrenForRerender, adultsForRerender);
    }
    if (childPassword.length < 8) {
      return renderRegisterError(res, `${c.firstName}'s password must be at least 8 characters.`, formValues, childrenForRerender, adultsForRerender);
    }
    if (childPassword !== c.loginPasswordConfirm) {
      return renderRegisterError(res, `${c.firstName}'s passwords do not match.`, formValues, childrenForRerender, adultsForRerender);
    }
  }

  for (const a of additionalParents) {
    if (!(a.firstName || '').trim() || !(a.lastName || '').trim()) {
      return renderRegisterError(res, 'Each additional parent/guardian needs both a first and last name.', formValues, childrenForRerender, adultsForRerender);
    }
    if (!a.wantsLogin) continue;
    const adultEmail = (a.email || '').trim();
    const adultPassword = a.loginPassword || '';
    if (!adultEmail || !adultPassword) {
      return renderRegisterError(res, `${a.firstName}'s portal login needs an email (in their Email field above) and a password.`, formValues, childrenForRerender, adultsForRerender);
    }
    if (adultPassword.length < 8) {
      return renderRegisterError(res, `${a.firstName}'s password must be at least 8 characters.`, formValues, childrenForRerender, adultsForRerender);
    }
    if (adultPassword !== a.loginPasswordConfirm) {
      return renderRegisterError(res, `${a.firstName}'s passwords do not match.`, formValues, childrenForRerender, adultsForRerender);
    }
  }

  // Every login email this submission is about to create, checked for
  // collisions both against each other (two kids typing the same email)
  // and against every existing account - a family accidentally reusing
  // the parent's own email for a child's login is exactly the kind of
  // mistake this needs to catch before anything is written.
  const wantedEmails = [
    email,
    ...children.filter((c) => c.wantsLogin).map((c) => (c.loginEmail || '').trim()),
    ...additionalParents.filter((a) => a.wantsLogin).map((a) => (a.email || '').trim()),
  ];
  const seen = new Set();
  for (const e of wantedEmails) {
    const key = e.toLowerCase();
    if (seen.has(key)) {
      return renderRegisterError(res, 'Each login on this form needs its own, different email address.', formValues, childrenForRerender, adultsForRerender);
    }
    seen.add(key);
  }
  for (const e of wantedEmails) {
    if (await findAccountByEmail(e)) {
      return renderRegisterError(res, `${e} is already in use by another account. Try logging in instead, or use a different email.`, formValues, childrenForRerender, adultsForRerender);
    }
  }

  const fullName = `${firstName} ${lastName}`;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();

  // "Should be able to upload parent profile photos and student profile
  // photos." Saved to disk/the storage bucket BEFORE the transaction
  // (not something a rolled-back transaction could undo anyway - a
  // saved file isn't itself transactional), same timing utils/
  // memberIntake.js's own callers already use (routes/membership.js).
  const primaryPhotoFile = (req.files || []).find((f) => f.fieldname === 'photo');
  const primaryPhotoPath = primaryPhotoFile ? await savePhotoFile(primaryPhotoFile) : null;
  const childPhotoPaths = {};
  for (const c of children) {
    const file = (req.files || []).find((f) => f.fieldname === `children[${c.index}][photo]`);
    childPhotoPaths[c.index] = file ? await savePhotoFile(file) : null;
  }
  const adultPhotoPaths = {};
  for (const a of additionalParents) {
    const file = (req.files || []).find((f) => f.fieldname === `additionalParents[${a.index}][photo]`);
    adultPhotoPaths[a.index] = file ? await savePhotoFile(file) : null;
  }

  // Custom field answers (utils/membershipFormFields.js) are saved
  // AFTER the transaction below, via the module-level `db` connection -
  // not from inside it via `tx`, since PGlite's single-connection test
  // engine hangs on an outer-`db` query while a `tx` transaction on that
  // same connection is still open (see utils/members.js's own
  // generateMemberCode comment on this exact class of bug).
  let newParentMemberId = null;
  const newChildMemberIds = [];
  const newAdultMemberIds = [];

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
        .prepare(
          `INSERT INTO members (name, barcode, member_code, member_type, email, phone, family_id, is_primary_parent, address, address2, city, state, zip, photo_path, sms_consent, sms_consent_at)
           VALUES (?, ?, ?, 'parent', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(fullName, code, code, email, phone || null, familyId, address || null, address2 || null, city || null, state || null, zip || null, primaryPhotoPath, smsOptIn, smsOptIn ? new Date().toISOString() : null);
      member = await tx.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
    } else if (phone && !member.phone) {
      await tx.prepare('UPDATE members SET phone = ? WHERE id = ?').run(phone, member.id);
    }
    if (smsOptIn && !member.sms_consent) {
      await tx.prepare('UPDATE members SET sms_consent = true, sms_consent_at = ? WHERE id = ?').run(new Date().toISOString(), member.id);
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

    // "When adding an additional parent there should be a check box that
    // says address is the same." Checked (the default) means this
    // adult's own posted address fields are ignored in favor of the
    // primary parent's - unchecked means they typed their own.
    for (const a of additionalParents) {
      const sameAddress = a.sameAddress === '1';
      const aCode = await generateMemberCode(tx);
      const aAddress = sameAddress ? address : (a.address || '').trim();
      const aAddress2 = sameAddress ? address2 : (a.address2 || '').trim();
      const aCity = sameAddress ? city : (a.city || '').trim();
      const aState = sameAddress ? state : (a.state || '').trim();
      const aZip = sameAddress ? zip : (a.zip || '').trim();
      const aInfo = await tx
        .prepare(
          `INSERT INTO members (name, barcode, member_code, member_type, family_id, email, phone, is_primary_parent, address, address2, city, state, zip, photo_path)
           VALUES (?, ?, ?, 'parent', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `${a.firstName.trim()} ${a.lastName.trim()}`,
          aCode,
          aCode,
          familyId,
          (a.email || '').trim() || null,
          (a.phone || '').trim() || null,
          aAddress || null,
          aAddress2 || null,
          aCity || null,
          aState || null,
          aZip || null,
          adultPhotoPaths[a.index] || null
        );
      newAdultMemberIds.push(aInfo.lastInsertRowid);

      // A real request: "For add an adult, also add check box for give
      // this parent their own portal log in" - same pending-account-plus-
      // role grant as the primary parent above, just keyed off this
      // adult's own wantsLogin checkbox instead of being unconditional.
      if (a.wantsLogin) {
        const adultEmail = (a.email || '').trim();
        const adultAccountInfo = await tx
          .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'pending')")
          .run(aInfo.lastInsertRowid, adultEmail, hashPassword(a.loginPassword));
        if (parentRole) {
          await tx.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(adultAccountInfo.lastInsertRowid, parentRole.id);
        }
      }
    }

    for (const c of children) {
      const childCode = await generateMemberCode(tx);
      const childInfo = await tx
        .prepare(
          `INSERT INTO members (name, barcode, member_code, member_type, family_id, birthday, medical_notes, photo_path)
           VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`
        )
        .run(
          `${c.firstName.trim()} ${c.lastName.trim()}`,
          childCode,
          childCode,
          familyId,
          isValidISODate((c.birthdate || '').trim()) ? c.birthdate.trim() : null,
          (c.medicalNotes || '').trim() || null,
          childPhotoPaths[c.index] || null
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
    // A real request: "add a general field section" - asked once per
    // application, recorded against the registering parent; same
    // req.body.customFields object the 'parent' save just above reads,
    // since saveFieldValues only pulls the keys matching the target it
    // was called with (see utils/membershipFormFields.js's own comment).
    await membershipFormFields.saveFieldValues(newParentMemberId, 'general', req.body.customFields);
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
  // A real request: "Homeschool family management tab on parent
  // portal. It needs to become its own portal and all the subpages
  // becomes the tabs." No new DB role for this - every account holding
  // the existing 'parent' role already has full access to /parent/
  // family-school (routes/parent-family-school.js's own
  // requirePortal('parent')) - this just gives that same role a SECOND
  // portal-switcher card and its own nav shell (views/partials/portal-
  // nav.ejs's own FAMILY_SCHOOL_NAV_LINKS), reached from the one 'parent'
  // role exactly the way a real second role would be.
  family_school: '/parent/family-school',
  student: '/student',
  teacher: '/teacher',
  coop_admin: '/admin',
  main_admin: '/main-admin',
};

// Splices a synthetic "Family School Management" card in right after
// the real 'parent' role - see PORTAL_HOME_ROUTES's own comment on why
// this is a second card for the same role rather than a second DB role.
function expandPortalRoles(roles) {
  const expanded = [];
  for (const role of roles) {
    expanded.push(role);
    if (role.key === 'parent') {
      expanded.push({
        key: 'family_school',
        label: 'Family School Management',
        description: 'Homeschool classes, grades, attendance, planners, and portfolio for your own family.',
      });
    }
  }
  return expanded;
}

// A real request: "Portal Choosing page. Change order. Parent portal,
// Co-op Teacher, Family School Management Portal, Main Admin Portal,
// Co-op Admin Portal, Student Portal." rolesForAccount's own `ORDER BY
// r.label` (utils/portalAuth.js) is alphabetical by design, and other
// callers of that same function rely on it just being "every role this
// account holds" with no particular order promised - so this is a
// display-only re-sort of the switcher's own card list, not a change to
// that query. Any role key not listed here (there isn't one today) just
// keeps falling in after every key that is, in whatever order it was in.
const PORTAL_SWITCHER_CARD_ORDER = ['parent', 'teacher', 'family_school', 'main_admin', 'coop_admin', 'student'];
function sortForPortalSwitcher(roles) {
  return [...roles].sort((a, b) => {
    const ai = PORTAL_SWITCHER_CARD_ORDER.indexOf(a.key);
    const bi = PORTAL_SWITCHER_CARD_ORDER.indexOf(b.key);
    return (ai === -1 ? PORTAL_SWITCHER_CARD_ORDER.length : ai) - (bi === -1 ? PORTAL_SWITCHER_CARD_ORDER.length : bi);
  });
}

router.get('/portal', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal');
  // A real request: "be able to lock members and they won't be able to
  // log in, unless to see and pay their account balance" - this page
  // doesn't go through middleware/portalAuth.js's own requirePortalAuth
  // (its locked-redirect lives there), so a locked account needs the
  // same check here directly.
  if (req.portalAccount.status === 'suspended') return res.redirect('/accounting?locked=1');
  const roles = sortForPortalSwitcher(expandPortalRoles(req.portalRoles));
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
  if (req.portalAccount.status === 'suspended') return res.redirect('/accounting?locked=1');
  res.render('portal-settings', { title: 'Settings' });
});

// A real request: "All portals settings gear. [They] are all now the
// card setup" - Student Portal and Co-op Teacher Portal's own gear used
// to open the bare page above directly; it now opens this card-view hub
// instead (portal-nav.ejs's own settingsHref), matching every other
// portal's own gear. sharedPortalTitle (middleware/portalAuth.js) is the
// same dual-role-safe resolution /portal/settings' own title already
// used - a ?portal=student|teacher query (portal-nav.ejs's own
// cornerPortalQuery) disambiguates a dual-role account the same way it
// already does for My Profile/Settings everywhere else.
router.get('/portal/settings-hub', (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fsettings-hub');
  res.render('portal-settings-hub', { title: 'Settings', navPortalTitle: res.locals.sharedPortalTitle('Settings') });
});

// A real request: "Clicking on the profile icon at the top on every
// portal should be the member's full profile membership form so that
// they can edit it. They still can't edit the birthday and grade level
// after joining though. They can see it but it's locked. Only admin can
// change that on their form. It will also have a tab for schedules,
// event signups." Distinct from the gear icon above (account-level
// settings, unchanged) - this is the member's OWN record, same fields
// the admin-side membership form edits (partials/member-form-fields.ejs),
// but self-service: no member type, family, admin position, or portal
// role controls here - those stay admin-only. Shared across every
// member-backed portal (parent/student/teacher/main_admin) since they
// all resolve to one members row via memberForAccount; the single shared
// Co-op Admin login (routes/admin.js) isn't tied to any one member, so
// it keeps its own separate /admin/settings instead.
const PROFILE_TABS = ['profile', 'schedules', 'signups'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function renderProfile(req, res, error, notice, activeTab) {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/portal');
  member.birthdayLabel = member.birthday ? formatDateLongNoWeekday(member.birthday) : null;
  const family = await familyForAccount(req.portalAccount.id);
  const familyIds = family.map((m) => m.id);
  const placeholders = familyIds.map(() => '?').join(',');

  let schedule = [];
  let signups = [];
  const tab = PROFILE_TABS.includes(activeTab) ? activeTab : 'profile';

  // A real request: "It will also have a tab for schedules, event
  // signups" followed by "Schedules tab should be organized by family
  // member and then by day under each family member" - the flat row set
  // below is unchanged (still every class_enrollments/class_staff row
  // across the whole family), just grouped into member -> day -> classes
  // here instead of rendered as one flat table. CLASS_DAYS (utils/
  // classDays.js) gives the sun-sat iteration order; family (already
  // fetched above, self first then otherFamilyMembers order) gives a
  // stable per-member section order instead of an alphabetical resort.
  if (tab === 'schedules') {
    const rows = await db
      .prepare(
        `SELECT c.day, c.hour_position, c.class_name, c.room, c.start_time, c.end_time, m.id AS "memberId", m.name AS "memberName", 'Student' AS "role"
         FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id JOIN members m ON m.id = ce.student_id
         WHERE ce.student_id IN (${placeholders})
         UNION ALL
         SELECT c.day, c.hour_position, c.class_name, c.room, c.start_time, c.end_time, m.id AS "memberId", m.name AS "memberName",
           CASE cs.role WHEN 'teacher' THEN 'Teacher' ELSE 'Assistant' END AS "role"
         FROM class_staff cs JOIN classes c ON c.id = cs.class_id JOIN members m ON m.id = cs.member_id
         WHERE cs.member_id IN (${placeholders})
         ORDER BY day, hour_position`
      )
      .all(...familyIds, ...familyIds);
    const byMemberId = new Map();
    for (const r of rows) {
      if (!byMemberId.has(r.memberId)) byMemberId.set(r.memberId, new Map());
      const byDay = byMemberId.get(r.memberId);
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push(r);
    }
    schedule = family.map((m) => {
      const byDay = byMemberId.get(m.id);
      return {
        memberName: m.name,
        days: byDay ? CLASS_DAYS.filter((d) => byDay.has(d)).map((d) => ({ day: d, classes: byDay.get(d) })) : [],
      };
    });
  } else if (tab === 'signups') {
    // A later real request: "Event signup tab should be organized by
    // month and then by event with drop down from the event to show who
    // signed up and what you may have signed up for like food,
    // volunteer etc." Three independent per-family queries (event
    // registrations themselves, sign_up_list_claims, and
    // volunteer_signup_list_signups - see utils/committeesAndSignupLists.js's
    // own header comment for the schema these two sign-up-list tables
    // share) merged into one event -> {registrations, items, shifts} map,
    // since a family could show up on any of the three independently
    // (e.g. claimed a food item for an event nobody in the family ever
    // formally "registered" for).
    const registrationRows = await db
      .prepare(
        `SELECT e.id, e.title, e.starts_at, er.status, m.name AS "memberName"
         FROM event_registrations er JOIN events e ON e.id = er.event_id JOIN members m ON m.id = er.member_id
         WHERE er.member_id IN (${placeholders}) AND er.status != 'cancelled'`
      )
      .all(...familyIds);
    const itemRows = await db
      .prepare(
        `SELECT sl.event_id AS "eventId", e.title, e.starts_at, sli.item_name AS "itemName", c.quantity_claimed AS "quantityClaimed", m.name AS "memberName"
         FROM sign_up_list_claims c
         JOIN sign_up_list_items sli ON sli.id = c.item_id
         JOIN sign_up_lists sl ON sl.id = sli.list_id
         JOIN events e ON e.id = sl.event_id
         JOIN members m ON m.id = c.member_id
         WHERE c.member_id IN (${placeholders}) AND sl.event_id IS NOT NULL`
      )
      .all(...familyIds);
    const shiftRows = await db
      .prepare(
        `SELECT vl.event_id AS "eventId", e.title, e.starts_at, vs.job_name AS "jobName", vs.shift_date AS "shiftDate", vs.start_time AS "startTime", vs.end_time AS "endTime", m.name AS "memberName"
         FROM volunteer_signup_list_signups s
         JOIN volunteer_signup_list_shifts vs ON vs.id = s.shift_id
         JOIN volunteer_signup_lists vl ON vl.id = vs.list_id
         JOIN events e ON e.id = vl.event_id
         JOIN members m ON m.id = s.member_id
         WHERE s.member_id IN (${placeholders}) AND vl.event_id IS NOT NULL`
      )
      .all(...familyIds);

    const eventsById = new Map();
    function eventEntry(id, title, startsAt) {
      if (!eventsById.has(id)) eventsById.set(id, { id, title, starts_at: startsAt, registrations: [], items: [], shifts: [] });
      return eventsById.get(id);
    }
    for (const r of registrationRows) eventEntry(r.id, r.title, r.starts_at).registrations.push({ memberName: r.memberName, status: r.status });
    for (const r of itemRows) eventEntry(r.eventId, r.title, r.starts_at).items.push({ itemName: r.itemName, memberName: r.memberName, quantityClaimed: r.quantityClaimed });
    for (const r of shiftRows) eventEntry(r.eventId, r.title, r.starts_at).shifts.push({ jobName: r.jobName, shiftDate: r.shiftDate, startTime: r.startTime, endTime: r.endTime, memberName: r.memberName });

    const events = Array.from(eventsById.values()).sort((a, b) => (a.starts_at || '').localeCompare(b.starts_at || ''));
    const monthsByKey = new Map();
    for (const ev of events) {
      const monthKey = (ev.starts_at || '').slice(0, 7);
      if (!monthsByKey.has(monthKey)) {
        const [y, mo] = monthKey.split('-');
        monthsByKey.set(monthKey, { monthLabel: `${MONTH_NAMES[parseInt(mo, 10) - 1]} ${y}`, events: [] });
      }
      monthsByKey.get(monthKey).events.push(ev);
    }
    signups = Array.from(monthsByKey.values());
  }

  // A real request: "Below the family section it should show what
  // sections and portals the member has permissions for" - the exact
  // same Sections/Portal Roles lookup member-profile-card.ejs's own GET
  // /portal/family/:memberId already does for a FAMILY member, here for
  // the signed-in account's own member instead. Only computed for the
  // 'profile' tab - the Schedules/Signups tabs above never render it.
  let memberSections = [];
  let memberPortalRoles = null;
  let familyName = null;
  if (tab === 'profile') {
    const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
    const memberSectionIds = (await sectionIdsForMembers([member.id]))[member.id];
    const portalStatus = (await portalStatusForMembers([member.id]))[member.id];
    const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();
    memberSections = allSections.filter((s) => memberSectionIds.has(s.id));
    memberPortalRoles = portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null;
    const familyRow = member.family_id ? await db.prepare('SELECT name FROM families WHERE id = ?').get(member.family_id) : null;
    familyName = familyRow ? familyRow.name : null;
  }

  res.render('portal-profile', {
    title: 'My Profile',
    member,
    // A real request: "when parent portal clicks the profile button,
    // keep the current profile view" - same read-only partials/member-
    // profile-card.ejs banner the Co-op/Main Admin portals and this
    // account's own /portal/family/:memberId already use, so the
    // Profile tab needs the same famParents/famChildren split that
    // partial expects (Parents includes self - see its own comment -
    // Children never does, filtered inside the partial itself).
    familyName,
    famParents: family.filter((m) => m.member_type !== 'student'),
    famChildren: family.filter((m) => m.member_type === 'student'),
    activeTab: tab,
    schedule,
    signups,
    memberSections,
    memberPortalRoles,
    gradeOptions: GRADE_OPTIONS,
    dayLabels: CLASS_DAY_LABELS_FULL,
    error,
    notice,
  });
}

router.get('/portal/profile', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile');
  await renderProfile(req, res, req.query.error || null, req.query.notice || null, req.query.tab);
});

// A real request: "Member profile for co-op admin portal, main admin
// portal, parent portal should match the image attached," answered with
// "Click a family member's name to open it" as this page's own entry
// point (the My Profile page's new "My Family" list above). Read-only -
// unlike the Co-op/Main Admin versions, there's no editHref and no
// Edit link in the banner (see views/partials/member-profile-card.ejs's
// own header comment). Family-scoped the same way every other family-
// wide portal feature already is: familyForAccount(req.portalAccount.id)
// IS the account's complete, real family roster, so a memberId outside
// it (someone else's family, or a typo) simply isn't found in that list -
// never a raw, unscoped `SELECT * FROM members WHERE id = ?`.
// Shared by the read-only card and its own edit page below - a memberId
// outside this account's own family is simply not found in family's own
// list, never a raw/unscoped `SELECT * FROM members WHERE id = ?`.
async function requireOwnFamilyMember(req, memberId) {
  const family = await familyForAccount(req.portalAccount.id);
  const member = family.find((m) => m.id === memberId);
  return member ? { family, member } : null;
}

router.get('/portal/family/:memberId', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile');
  const found = await requireOwnFamilyMember(req, parseInt(req.params.memberId, 10));
  if (!found) return res.status(404).send('Not found');
  const { family, member } = found;
  member.birthdayLabel = member.birthday ? formatDateLongNoWeekday(member.birthday) : null;

  const familyRow = member.family_id ? await db.prepare('SELECT name FROM families WHERE id = ?').get(member.family_id) : null;
  const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const memberSectionIds = (await sectionIdsForMembers([member.id]))[member.id];
  const portalStatus = (await portalStatusForMembers([member.id]))[member.id];
  const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();

  res.render('parent-member-profile', {
    title: member.name,
    member,
    familyName: familyRow ? familyRow.name : null,
    famParents: family.filter((m) => m.member_type !== 'student'),
    famChildren: family.filter((m) => m.member_type === 'student'),
    memberSections: allSections.filter((s) => memberSectionIds.has(s.id)),
    memberPortalRoles: portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null,
    // A real request: "When clicking on a child or adult profile there
    // it should allow parent to edit their profiles as well, not just
    // view" - member-profile-card.ejs's own editHref local (already
    // used by the Co-op/Main Admin versions of this same shared card)
    // just needed a target here too.
    editHref: `/portal/family/${member.id}/edit`,
  });
});

router.get('/portal/family/:memberId/edit', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile');
  const found = await requireOwnFamilyMember(req, parseInt(req.params.memberId, 10));
  if (!found) return res.status(404).send('Not found');
  found.member.birthdayLabel = found.member.birthday ? formatDateLongNoWeekday(found.member.birthday) : null;
  // A real request: "Be able to change student's email when editing
  // student profile" - the plain `email` field below is just contact
  // info (members.email, no login tied to it); this is the actual
  // sign-in credential (member_accounts.email) a student logs in with,
  // so it only shows up here when a student member actually has one.
  const account = found.member.member_type === 'student' ? await db.prepare('SELECT id, email FROM member_accounts WHERE member_id = ?').get(found.member.id) : null;
  res.render('parent-member-profile-edit', {
    title: `Edit ${found.member.name}`,
    member: found.member,
    account,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Deliberately narrow - the same "just contact info" field set (name/
// address/city/state/zip/phone/email/medicalNotes) POST /portal/profile
// already restricts a member to editing on themselves, now also
// available for a parent editing another member of their own family.
// member_type, birthday, grade_level, family_id, and admin positions
// never appear in this request at all, for the same reason POST
// /portal/profile's own header comment gives. loginEmail is the one
// exception - see the GET route above's own comment on why it's a
// separate, account-level field only shown (and only ever read here)
// for a student who already has a portal account.
router.post('/portal/family/:memberId/edit', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile');
  const memberId = parseInt(req.params.memberId, 10);
  const found = await requireOwnFamilyMember(req, memberId);
  if (!found) return res.status(404).send('Not found');
  const back = `/portal/family/${memberId}/edit`;

  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(back + '?error=' + encodeURIComponent('Name is required.'));

  if (found.member.member_type === 'student' && req.body.loginEmail !== undefined) {
    const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(memberId);
    if (account) {
      const loginEmail = req.body.loginEmail.trim();
      if (!loginEmail) return res.redirect(back + '?error=' + encodeURIComponent('Login email is required.'));
      const existing = await findAccountByEmail(loginEmail);
      if (existing && existing.id !== account.id) return res.redirect(back + '?error=' + encodeURIComponent('That email is already in use by another account.'));
      await db.prepare('UPDATE member_accounts SET email = ? WHERE id = ?').run(loginEmail, account.id);
    }
  }

  await db
    .prepare('UPDATE members SET name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?, medical_notes = ? WHERE id = ?')
    .run(
      name,
      (req.body.address || '').trim() || null,
      (req.body.city || '').trim() || null,
      (req.body.state || '').trim() || null,
      (req.body.zip || '').trim() || null,
      (req.body.phone || '').trim() || null,
      (req.body.email || '').trim() || null,
      (req.body.medicalNotes || '').trim() || null,
      memberId
    );

  res.redirect(back + '?notice=' + encodeURIComponent('Profile updated.'));
});

// A real request: "when parent portal clicks the profile button, keep
// the current profile view. When you click the edit profile button it
// should look exactly like the membership request form. Exactly."
// Replaces the old POST /portal/profile (narrow "just contact info"
// fields, no photo, no password) and the standalone Password tab
// (routes this same file used to expose at POST /portal/profile/
// password) - this one page covers everything either of those used to,
// same field set/order/styling as partials/member-edit-fields.ejs's own
// header comment describes (shared with both admin portals' Edit Member
// pages), minus the admin-only Family/Sections/Portal Roles section
// those get (a parent can't reassign their own family or grant their
// own portal roles).
router.get('/portal/profile/edit', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile%2Fedit');
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/portal');
  res.render('portal-profile-edit', {
    title: `Edit ${member.name}`,
    member,
    gradeLevels: GRADE_OPTIONS,
    portalAccount: req.portalAccount,
    // A real request: "Parent portal, profile icon, edit button, should
    // look exactly like the membership request form. All sections and
    // features should be the same." - see utils/memberFamilyEdit.js's
    // own header comment.
    ...(await familyEditSections(member.id)),
    // A real request: "Don't forget the check box questions. This
    // should look IDENTICAL to the membership request form." - same
    // admin-defined questions the public form asks, with this member's
    // own already-answered values prefilled.
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
    generalFields: await membershipFormFields.listFields('general'),
    customFieldValues: await membershipFormFields.fieldValuesForView(member.id),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/portal/profile/edit', uploadIntakePhotos(() => '/portal/profile/edit'), async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile%2Fedit');
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/portal');
  const back = '/portal/profile/edit';
  // multer.any() (uploadIntakePhotos) replaces the old single-file
  // uploadMemberPhoto middleware now that this same submission can also
  // carry a photo per Additional Parent/Children block below (req.files
  // is an array, matched by fieldname - see utils/memberFamilyEdit.js's
  // own fileFor) - this member's own photo still posts under the plain
  // "photo" field name, unchanged.
  const photoFile = (req.files || []).find((file) => file.fieldname === 'photo');

  const name = (req.body.name || '').trim();
  if (!name) {
    return res.redirect(back + '?error=' + encodeURIComponent('Name is required.'));
  }

  // Same optional-password handling as the admin Edit Member forms this
  // page now matches, plus a Confirm Password check (the member typing
  // it is the one who'll use it, unlike an admin setting someone else's).
  const newPassword = req.body.password || '';
  const confirmPassword = req.body.confirmPassword || '';
  if (newPassword) {
    if (newPassword.length < 8) {
      return res.redirect(back + '?error=' + encodeURIComponent('Password must be at least 8 characters.'));
    }
    if (newPassword !== confirmPassword) {
      return res.redirect(back + '?error=' + encodeURIComponent('Passwords do not match.'));
    }
  }

  const photoPath = photoFile ? await saveMemberPhotoFile(photoFile) : member.photo_path;
  if (photoFile && member.photo_path) await deleteMemberPhotoFile(member.photo_path);

  const address = (req.body.address || '').trim() || null;
  const address2 = (req.body.address2 || '').trim() || null;
  const city = (req.body.city || '').trim() || null;
  const state = (req.body.state || '').trim() || null;
  const zip = (req.body.zip || '').trim() || null;

  await db
    .prepare(
      `UPDATE members SET name = ?, address = ?, address2 = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?, medical_notes = ?, photo_path = ? WHERE id = ?`
    )
    .run(
      name,
      address,
      address2,
      city,
      state,
      zip,
      (req.body.phone || '').trim() || null,
      (req.body.email || '').trim() || null,
      (req.body.medicalNotes || '').trim() || null,
      photoPath,
      member.id
    );
  if (member.member_type !== 'student') await setPrimaryParent(member.id, req.body.isPrimaryParent === '1');

  if (newPassword) {
    await db.prepare('UPDATE member_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.portalAccount.id);
  }

  // A real request: "Don't forget the check box questions. This should
  // look IDENTICAL to the membership request form." - see routes/
  // main-admin-members.js's own identical POST /:id/edit comment.
  const customFieldsTarget = member.member_type === 'student' ? 'child' : 'parent';
  await membershipFormFields.saveFieldValues(member.id, customFieldsTarget, req.body.customFields);
  if (customFieldsTarget === 'parent') {
    await membershipFormFields.saveFieldValues(member.id, 'general', req.body.customFields);
  }

  // A real request: "Parent portal, profile icon, edit button, should
  // look exactly like the membership request form. All sections and
  // features should be the same." - see utils/memberFamilyEdit.js's own
  // header comment. createdByAccountId is null - a parent's own self-
  // edit isn't a Main Admin account, so a brand-new family member added
  // here has nothing to attribute their account's approval to, same as
  // Co-op Admin's own identical call.
  const familyError = await applyFamilyEditSubmission(req, {
    familyId: member.family_id,
    address: { address, address2, city, state, zip },
    createdByAccountId: null,
  });
  if (familyError) return res.redirect(back + '?error=' + encodeURIComponent(familyError));

  res.redirect('/portal/profile?notice=' + encodeURIComponent('Profile updated.'));
});

module.exports = router;
