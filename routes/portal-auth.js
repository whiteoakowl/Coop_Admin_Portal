// Login/registration for the new member portal platform - see
// utils/portalAuth.js and middleware/portalAuth.js for the account/role
// model this drives. Completely separate from the single shared Admin
// login (routes/admin.js) and the kiosk's own no-login trust model.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { findAccountByEmail, verifyPassword, hashPassword, memberForAccount, familyForAccount } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');
const { createFailureRateLimiter } = require('../utils/loginRateLimit');
const { GRADE_OPTIONS } = require('../utils/membership');
const { CLASS_DAY_LABELS_FULL } = require('../utils/classSchedule');
const { CLASS_DAYS } = require('../utils/classDays');
const { isValidISODate, formatDateNumeric } = require('../utils/dates');
const { portalStatusForMembers, sectionIdsForMembers } = require('../utils/portalPermissions');
const membershipHandbook = require('../utils/membershipHandbook');
const membershipFormFields = require('../utils/membershipFormFields');
const path = require('path');
const fs = require('fs');
const { createStorageClient, downloadFile } = require('../utils/storage');

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

router.get('/register', async (req, res) => {
  if (req.portalAccount) return res.redirect('/portal');
  res.render('portal-register', {
    title: 'Request Membership',
    error: null,
    formValues: {},
    children: [],
    gradeOptions: GRADE_OPTIONS,
    handbookHtml: await membershipHandbook.getHandbookHtml(),
    handbookFile: await membershipHandbook.getHandbookFile(),
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
    handbookFile: await membershipHandbook.getHandbookFile(),
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
  if (tab === 'profile') {
    const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
    const memberSectionIds = (await sectionIdsForMembers([member.id]))[member.id];
    const portalStatus = (await portalStatusForMembers([member.id]))[member.id];
    const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();
    memberSections = allSections.filter((s) => memberSectionIds.has(s.id));
    memberPortalRoles = portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null;
  }

  res.render('portal-profile', {
    title: 'My Profile',
    member,
    // Everyone else sharing this account's family - a real request:
    // "Click a family member's name to open it" as the entry point into
    // the new Member Profile page (views/parent-member-profile.ejs) below.
    // Self is left out the same way member-profile-card.ejs's own
    // famParents/famChildren already exclude the profile's own subject.
    otherFamilyMembers: family.filter((m) => m.id !== member.id),
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
  member.birthdayLabel = member.birthday ? formatDateNumeric(member.birthday) : null;

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
  res.render('parent-member-profile-edit', {
    title: `Edit ${found.member.name}`,
    member: found.member,
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
// /portal/profile's own header comment gives.
router.post('/portal/family/:memberId/edit', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile');
  const memberId = parseInt(req.params.memberId, 10);
  const found = await requireOwnFamilyMember(req, memberId);
  if (!found) return res.status(404).send('Not found');

  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(`/portal/family/${memberId}/edit?error=` + encodeURIComponent('Name is required.'));

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

  res.redirect(`/portal/family/${memberId}/edit?notice=` + encodeURIComponent('Profile updated.'));
});

// Deliberately narrow - only the fields the admin-side membership form
// also treats as "just contact info" (see partials/member-form-fields.ejs)
// are writable here. member_type, birthday, grade_level, family_id, and
// admin positions never appear in this request at all, so there's
// nothing for a raw/spoofed submission to even attempt to change - not a
// value that gets silently discarded, a field that was simply never read.
router.post('/portal/profile', async (req, res) => {
  if (!req.portalAccount) return res.redirect('/login?next=%2Fportal%2Fprofile');
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/portal');

  const name = (req.body.name || '').trim();
  if (!name) {
    return res.redirect('/portal/profile?error=' + encodeURIComponent('Name is required.'));
  }

  await db
    .prepare(
      `UPDATE members SET name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?, medical_notes = ? WHERE id = ?`
    )
    .run(
      name,
      (req.body.address || '').trim() || null,
      (req.body.city || '').trim() || null,
      (req.body.state || '').trim() || null,
      (req.body.zip || '').trim() || null,
      (req.body.phone || '').trim() || null,
      (req.body.email || '').trim() || null,
      (req.body.medicalNotes || '').trim() || null,
      member.id
    );

  res.redirect('/portal/profile?notice=' + encodeURIComponent('Profile updated.'));
});

module.exports = router;
