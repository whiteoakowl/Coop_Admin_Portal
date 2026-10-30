// Shared "Additional Parents"/"Children" sections for the unified member
// edit pages (Main Admin/Co-op Admin Edit Member, Parent Portal Edit
// Profile) - a real request: "this page should look exactly like the
// membership request form. The additional parent sections and
// information, children sections and information." Reuses the exact
// additionalParents[]/children[] array shape the public self-
// registration form already posts (routes/portal-auth.js's own POST
// /register, partials/register-adult-fields.ejs/register-child-fields.ejs),
// adapted so a block can also carry a real, already-existing member's id
// (partials/member-edit-adult-block.ejs/member-edit-child-block.ejs) and
// UPDATE that person in place, instead of only ever INSERTing a brand-new
// one. An existing family member can never be deleted from here - a
// block with a real id and a blanked-out name is simply left unchanged
// (see applyAdditionalParents'/applyChildren's own comments), the same
// "no destructive surprise" reasoning as the birthday-preservation fix in
// routes/admin-members.js's own memberFormFields.
const db = require('../db');
const { familyOf, generateMemberCode } = require('./members');
const { parseArrayField, savePhotoFile } = require('./memberIntake');
const { deletePhotoFile } = require('./memberPhoto');
const { ensurePortalAccountForMember, hashPassword } = require('./portalAuth');
const { portalStatusForMembers } = require('./portalPermissions');
const { listFields, fieldValuesForView, saveFieldValues } = require('./membershipFormFields');

function fileFor(files, fieldname) {
  return (files || []).find((f) => f.fieldname === fieldname);
}

// Builds the view locals for the GET edit routes - every other member of
// memberId's own family (admins count as parents, same convention
// partials/member-profile-card.ejs's own famParents already uses), split
// into Additional Parents/Children, each paired with its own portal
// account status for the block's login section to prefill from. Also
// returns childFields (utils/membershipFormFields.js) - a real request:
// "Don't forget the check box questions. This should look IDENTICAL to
// the membership request form" - each child entry carries its own
// already-answered customFieldValues, same as the public form's own
// register-child-fields.ejs asks for (additional parents never get
// custom questions either way, same as that form).
async function familyEditSections(memberId) {
  const family = await familyOf(memberId);
  const ids = family.map((m) => m.id);
  const statusByMemberId = ids.length ? await portalStatusForMembers(ids) : {};
  const adults = family.filter((m) => m.member_type !== 'student').map((m) => ({ member: m, portalStatus: statusByMemberId[m.id] }));
  const childMembers = family.filter((m) => m.member_type === 'student');
  const children = await Promise.all(
    childMembers.map(async (m) => ({ member: m, portalStatus: statusByMemberId[m.id], customFieldValues: await fieldValuesForView(m.id) }))
  );
  return { familyAdults: adults, familyChildren: children, familyChildFields: await listFields('child') };
}

// address: { address, address2, city, state, zip } - the primary member's
// OWN current address (already saved by the time this runs - see each
// POST route's own call order), used whenever a block's own "sameAddress"
// checkbox is checked.
async function applyAdditionalParents(req, familyId, address, createdByAccountId, allowLogin) {
  const entries = parseArrayField(req.body, 'additionalParents');
  if (entries.length === 0) return null;

  const existingIds = entries.map((a) => parseInt(a.id, 10)).filter(Number.isInteger);
  const existingMembers = existingIds.length
    ? await db.prepare(`SELECT * FROM members WHERE family_id = ? AND id IN (${existingIds.map(() => '?').join(',')})`).all(familyId, ...existingIds)
    : [];
  const existingById = new Map(existingMembers.map((m) => [m.id, m]));
  const statusByMemberId = existingIds.length ? await portalStatusForMembers(existingIds) : {};

  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i];
    const name = (a.name || '').trim();
    const id = parseInt(a.id, 10);
    const existing = Number.isInteger(id) ? existingById.get(id) : null;
    const photoFile = fileFor(req.files, `additionalParents[${i}][photo]`);
    const sameAddress = a.sameAddress === '1';
    const email = (a.email || '').trim() || null;
    const phone = (a.phone || '').trim() || null;
    const aAddress = sameAddress ? address.address : (a.address || '').trim() || null;
    const aAddress2 = sameAddress ? address.address2 : (a.address2 || '').trim() || null;
    const aCity = sameAddress ? address.city : (a.city || '').trim() || null;
    const aState = sameAddress ? address.state : (a.state || '').trim() || null;
    const aZip = sameAddress ? address.zip : (a.zip || '').trim() || null;

    if (existing) {
      // A blanked-out Full Name on a real, already-existing family member
      // is a no-op, not a delete - this form has no way to remove a real
      // person (see this file's own header comment), so nothing about
      // them changes rather than erroring the whole page save.
      if (!name) continue;
      const photoPath = photoFile ? await savePhotoFile(photoFile) : existing.photo_path;
      if (photoFile && existing.photo_path) await deletePhotoFile(existing.photo_path);
      await db
        .prepare('UPDATE members SET name = ?, email = ?, phone = ?, address = ?, address2 = ?, city = ?, state = ?, zip = ?, photo_path = ? WHERE id = ?')
        .run(name, email, phone, aAddress, aAddress2, aCity, aState, aZip, photoPath, existing.id);

      // A real request: "Allow member to create portal. The two
      // checkboxes on the member request form" - back to the opt-in
      // "Give this parent their own portal login" checkbox (partials/
      // member-edit-adult-block.ejs), same as the public form's own.
      // Checking it defaults the password to changeme123 (same as
      // ensurePortalAccountForMember's own default everywhere else in
      // this app) whenever the Password field itself is left blank.
      if (allowLogin && a.wantsLogin) {
        const status = statusByMemberId[existing.id];
        if (status && status.account) {
          if (a.loginPassword) await db.prepare('UPDATE member_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(a.loginPassword), status.account.id);
        } else if (email) {
          if (a.loginPassword && a.loginPassword.length < 8) return `${name}'s password must be at least 8 characters.`;
          await ensurePortalAccountForMember(existing.id, email, createdByAccountId, a.loginPassword || undefined);
        }
      }
      continue;
    }

    // A completely blank new block is silently dropped, same as the
    // public registration form's own additionalParents filter.
    if (!name) continue;
    if (allowLogin && a.wantsLogin && a.loginPassword && a.loginPassword.length < 8) return `${name}'s password must be at least 8 characters.`;
    const code = await generateMemberCode();
    const photoPath = photoFile ? await savePhotoFile(photoFile) : null;
    const info = await db
      .prepare(
        `INSERT INTO members (name, barcode, member_code, member_type, family_id, email, phone, is_primary_parent, address, address2, city, state, zip, photo_path)
         VALUES (?, ?, ?, 'parent', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(name, code, code, familyId, email, phone, aAddress, aAddress2, aCity, aState, aZip, photoPath);
    if (allowLogin && a.wantsLogin && email) await ensurePortalAccountForMember(info.lastInsertRowid, email, createdByAccountId, a.loginPassword || undefined);
  }
  return null;
}

async function applyChildren(req, familyId, createdByAccountId, allowLogin) {
  const entries = parseArrayField(req.body, 'children');
  if (entries.length === 0) return null;

  const existingIds = entries.map((c) => parseInt(c.id, 10)).filter(Number.isInteger);
  const existingMembers = existingIds.length
    ? await db.prepare(`SELECT * FROM members WHERE family_id = ? AND id IN (${existingIds.map(() => '?').join(',')})`).all(familyId, ...existingIds)
    : [];
  const existingById = new Map(existingMembers.map((m) => [m.id, m]));
  const statusByMemberId = existingIds.length ? await portalStatusForMembers(existingIds) : {};

  for (let i = 0; i < entries.length; i += 1) {
    const c = entries[i];
    const name = (c.name || '').trim();
    const id = parseInt(c.id, 10);
    const existing = Number.isInteger(id) ? existingById.get(id) : null;
    const photoFile = fileFor(req.files, `children[${i}][photo]`);
    const birthday = (c.birthdate || '').trim() || null;
    const medicalNotes = (c.medicalNotes || '').trim() || null;

    if (existing) {
      // Same no-op-not-a-delete reasoning as applyAdditionalParents above.
      if (!name) continue;
      const photoPath = photoFile ? await savePhotoFile(photoFile) : existing.photo_path;
      if (photoFile && existing.photo_path) await deletePhotoFile(existing.photo_path);
      await db
        .prepare('UPDATE members SET name = ?, birthday = ?, medical_notes = ?, photo_path = ? WHERE id = ?')
        .run(name, birthday, medicalNotes, photoPath, existing.id);
      // A real request: "Don't forget the check box questions. This
      // should look IDENTICAL to the membership request form" - same
      // admin-defined questions register-child-fields.ejs's own loop
      // asks, saved the same way routes/portal-auth.js's own POST
      // /register already does.
      await saveFieldValues(existing.id, 'child', c.customFields);

      // A real request: "Allow member to create portal. The two
      // checkboxes on the member request form" - back to the opt-in
      // "Give this student their own portal login" checkbox (partials/
      // member-edit-child-block.ejs), same as the public form's own.
      // c.loginEmail is still the one field with no default to fall
      // back to - a child has no contact email column at all (see that
      // partial's own header comment) - but creating the account itself
      // is gated on the checkbox again, not automatic.
      if (allowLogin && c.wantsLogin) {
        const status = statusByMemberId[existing.id];
        const loginEmail = (c.loginEmail || '').trim();
        if (status && status.account) {
          if (c.loginPassword) await db.prepare('UPDATE member_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(c.loginPassword), status.account.id);
        } else if (loginEmail) {
          if (c.loginPassword && c.loginPassword.length < 8) return `${name}'s password must be at least 8 characters.`;
          await ensurePortalAccountForMember(existing.id, loginEmail, createdByAccountId, c.loginPassword || undefined);
        }
      }
      continue;
    }

    // Same blank-block-dropped reasoning as applyAdditionalParents above.
    if (!name) continue;
    const loginEmail = (c.loginEmail || '').trim();
    if (allowLogin && c.wantsLogin && c.loginPassword && c.loginPassword.length < 8) return `${name}'s password must be at least 8 characters.`;
    const code = await generateMemberCode();
    const photoPath = photoFile ? await savePhotoFile(photoFile) : null;
    const info = await db
      .prepare(`INSERT INTO members (name, barcode, member_code, member_type, family_id, birthday, medical_notes, photo_path) VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`)
      .run(name, code, code, familyId, birthday, medicalNotes, photoPath);
    await saveFieldValues(info.lastInsertRowid, 'child', c.customFields);
    if (allowLogin && c.wantsLogin && loginEmail) await ensurePortalAccountForMember(info.lastInsertRowid, loginEmail, createdByAccountId, c.loginPassword || undefined);
  }
  return null;
}

// One entry point for all three edit routes - applies both sections in
// order and stops at the first validation error (same as the public
// registration form's own all-or-nothing posture), returning that error
// string, or null on success. allowLogin is false for Co-op Admin's own
// edit page - creating or changing a portal account/password has always
// been Main-Admin-only (see routes/admin-members.js's own "No creating
// users" comment); partials/member-edit-adult-block.ejs/member-edit-
// child-block.ejs already never render the login checkbox there at all,
// this is just the matching server-side refusal for a raw/spoofed
// request that skips the form entirely.
async function applyFamilyEditSubmission(req, { familyId, address, createdByAccountId, allowLogin = true }) {
  if (familyId == null) return null;
  const adultError = await applyAdditionalParents(req, familyId, address, createdByAccountId, allowLogin);
  if (adultError) return adultError;
  return applyChildren(req, familyId, createdByAccountId, allowLogin);
}

module.exports = { familyEditSections, applyFamilyEditSubmission };
