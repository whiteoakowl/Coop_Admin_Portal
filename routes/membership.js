// The Membership Form - admin-only (see the header comment this used to
// carry: an admin fills it out on a family's behalf, from a paper form
// or a phone call), NOT one of the app's genuine public forms. A real
// request: "Add member and membership request form should be the same
// ... however it will still create individual profiles." Now shares
// views/member-intake-form.ejs and utils/memberIntake.js with Main
// Admin's and Co-op Admin's own Add Member forms (routes/main-admin-
// members.js, routes/admin-members.js) rather than being a third,
// separately-built form that only ever produced a PENDING
// membership_requests/membership_request_children row for someone to
// review later - every one of these three entry points is already
// admin-gated, so that staging step never added real review it needed.
//
// Still lives outside the /admin URL prefix (unchanged, to avoid
// disturbing anything that already links to /membership) and still
// applies requireFullAdmin per-route rather than router-level, for the
// same root-mounted-router reason its own original comment explained.
const express = require('express');
const router = express.Router();
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { GRADE_LEVELS, CLASS_DAY_LABELS_FULL } = require('../utils/classSchedule');
const { isValidISODate } = require('../utils/dates');
const { allFamilies } = require('../utils/members');
const { resolveFamilyId, createParentMember, createChildMember, uploadIntakePhotos, parseArrayField } = require('../utils/memberIntake');
const membershipFormFields = require('../utils/membershipFormFields');

async function allSetupTeams() {
  return db.prepare('SELECT id, day, title FROM setup_teams ORDER BY day, LOWER(title)').all();
}

router.get('/membership', requireFullAdmin, async (req, res) => {
  res.render('member-intake-form', {
    title: 'Membership Form',
    portal: 'coop_admin',
    formAction: '/membership',
    backHref: '/admin/members',
    submitLabel: 'Submit',
    isAdmin: true,
    families: await allFamilies(),
    setupTeams: await allSetupTeams(),
    dayLabels: CLASS_DAY_LABELS_FULL,
    gradeLevels: GRADE_LEVELS,
    parentFields: await membershipFormFields.listFields('parent'),
    childFields: await membershipFormFields.listFields('child'),
    generalFields: await membershipFormFields.listFields('general'),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/membership', requireFullAdmin, uploadIntakePhotos('/membership'), async (req, res) => {
  const body = req.body;
  const back = '/membership';

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

  // See routes/main-admin-members.js's own matching comment on its POST
  // /new - same optional email/password validation, this form shares the
  // exact same view/fields.
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

  const familyId = await resolveFamilyId({ familyId: body.familyId, newFamilyName: body.newFamilyName, homeschoolDuration: body.homeschoolDuration });

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
    });
    if (firstParentMemberId == null) firstParentMemberId = parentMemberId;
  }
  // A real request: "add a general field section" - see routes/main-
  // admin-members.js's own matching POST /new comment.
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
        // Silently dropped rather than rejecting the whole submission -
        // a malformed birthdate here isn't fatal, it just leaves this
        // one field blank for later editing.
        birthday: isValidISODate((c.birthday || '').trim()) ? c.birthday.trim() : null,
        gradeLevel: GRADE_LEVELS.includes(c.gradeLevel) ? c.gradeLevel : null,
        medicalNotes: (c.medicalNotes || '').trim() || null,
        email: (c.email || '').trim() || null,
        password: c.password || null,
        customFieldValues: c.customFields,
      },
      photoFile
    );
  }

  res.redirect('/membership?notice=' + encodeURIComponent(`Added ${parents.length + children.length} member(s).`));
});

module.exports = router;
