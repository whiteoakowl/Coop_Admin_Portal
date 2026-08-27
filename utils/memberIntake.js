// Unified family intake - creates one or more individual `members` rows
// from ONE form submission. A real request: "Add member and membership
// request form should be the same... form should allow all members of
// the family to signup at one time and save. however it will still
// create individual profiles." Shared by routes/admin-members.js
// (/admin/members/new), routes/main-admin-members.js (/main-admin/
// members/new), and routes/membership.js (/membership) - three
// previously separate, partially redundant forms (Add Member was
// single-person only; Membership Form supported multiple people but only
// ever created a PENDING membership_requests/membership_request_children
// row for later review, never real members - see the migration this
// replaces that flow with, dropping that staging step entirely since
// every one of these three entry points is already admin-gated, so
// there was never a real "needs review before becoming real" step to
// begin with).
const db = require('../db');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { generateMemberCode } = require('./members');
const { createStorageClient } = require('./storage');
const { saveUpload } = require('./uploadBackend');
const { imageFileFilter } = require('./uploads');

const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'members');
const MEMBER_PHOTOS_BUCKET = 'member-photos';
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

const MAX_CHILD_PHOTO_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CHILD_PHOTO_BYTES }, fileFilter: imageFileFilter });

// One student photo per child block (`children[N][photo]`), any number
// of blocks - multer.any() rather than .single(), since the field name
// itself carries the child's index and there can be several. A photo
// over the limit above makes multer.any() itself throw a MulterError
// (LIMIT_FILE_SIZE) - unlike imageFileFilter rejecting a wrong file TYPE
// (which just leaves that one file out of req.files), this error was
// never caught anywhere, so it fell through to server.js's generic
// catch-all error handler and threw away everything else on the form.
// Same fix as routes/admin-documents.js's own uploadDocument wrapper.
// `back` is the URL to redirect to on that one error case.
function uploadIntakePhotos(back) {
  return function (req, res, next) {
    upload.any()(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.redirect(`${back}?error=` + encodeURIComponent(`That photo is too large - photos are limited to ${MAX_CHILD_PHOTO_BYTES / (1024 * 1024)}MB.`));
      }
      next(err);
    });
  };
}

// multer parses "parents[0][name]"/"children[0][name]" style multipart
// fields into real (possibly sparse, if a block was removed client-side)
// nested arrays on req.body.parents/req.body.children - the array index
// already lines up with the original bracket index used in uploaded file
// fieldnames. Deliberately 0-based sequential indices, NOT a database
// id, in the bracket itself - see utils/portalPermissions.js's own
// comment on why a database id there would hit qs's small-integer-
// bracket-as-array-index behavior; a real sequential index is exactly
// what that behavior is FOR, so it's safe here.
function parseArrayField(body, key) {
  const raw = body[key];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.keys(raw).map((k) => raw[k]);
  return [];
}

function savePhotoFile(file) {
  return saveUpload({
    client: storageClient,
    bucket: MEMBER_PHOTOS_BUCKET,
    localDir: PHOTO_DIR,
    buffer: file.buffer,
    originalName: file.originalname,
    contentType: file.mimetype,
  });
}

// A typed "new family" name wins over the dropdown when both are
// somehow present, and reuses an existing family of that exact name
// rather than creating a duplicate - same "create-or-reuse" shape every
// other family selector in this app already follows (routes/main-admin-
// members.js's own resolveFamilyId, routes/admin-members.js's
// ensureFamilyForParent).
// homeschoolDuration: "how long has the family been homeschooling" - a
// real request. Free text ("3 years", "since 2019"), always saved onto
// whichever family this submission resolves to (new or existing) when
// given, since a family already on file may not have answered it yet.
async function resolveFamilyId({ familyId, newFamilyName, homeschoolDuration }) {
  const trimmedDuration = (homeschoolDuration || '').trim() || null;
  const trimmed = (newFamilyName || '').trim();
  let id;
  if (trimmed) {
    const existing = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(trimmed);
    if (existing) {
      id = existing.id;
    } else {
      const info = await db.prepare('INSERT INTO families (name, homeschool_duration) VALUES (?, ?)').run(trimmed, trimmedDuration);
      return info.lastInsertRowid;
    }
  } else {
    const parsed = parseInt(familyId, 10);
    id = Number.isInteger(parsed) ? parsed : null;
  }
  if (id && trimmedDuration) {
    await db.prepare('UPDATE families SET homeschool_duration = ? WHERE id = ?').run(trimmedDuration, id);
  }
  return id;
}

async function syncCleanupTeam(memberId, teamId) {
  await db.prepare('DELETE FROM setup_team_members WHERE member_id = ?').run(memberId);
  if (!teamId) return;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?) ON CONFLICT (team_id, member_id) DO NOTHING').run(teamId, memberId);
}

// parent: { name, email, phone, isPrimaryParent, cleanupTeamId } -
// cleanupTeamId only ever set from an admin-filled form (see this
// module's own header comment - every caller of this function is
// already admin-gated, but the field itself is only ever rendered to an
// admin in the shared view, per "should only show to admins").
async function createParentMember(familyId, address, parent) {
  const memberCode = await generateMemberCode();
  const info = await db
    .prepare(
      `INSERT INTO members (name, barcode, member_code, member_type, family_id, address, city, state, zip, phone, email, is_primary_parent)
       VALUES (?, ?, ?, 'parent', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(parent.name, memberCode, memberCode, familyId, address.address, address.city, address.state, address.zip, parent.phone || null, parent.email || null, parent.isPrimaryParent ? 1 : 0);
  await syncCleanupTeam(info.lastInsertRowid, parent.cleanupTeamId || null);
  return info.lastInsertRowid;
}

// child: { name, birthday, gradeLevel, medicalNotes }, photoFile: a
// multer file object or null/undefined.
async function createChildMember(familyId, address, child, photoFile) {
  const memberCode = await generateMemberCode();
  const photoPath = photoFile ? await savePhotoFile(photoFile) : null;
  const info = await db
    .prepare(
      `INSERT INTO members (name, barcode, member_code, member_type, family_id, address, city, state, zip, birthday, grade_level, medical_notes, photo_path)
       VALUES (?, ?, ?, 'student', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(child.name, memberCode, memberCode, familyId, address.address, address.city, address.state, address.zip, child.birthday || null, child.gradeLevel || null, child.medicalNotes || null, photoPath);
  return info.lastInsertRowid;
}

module.exports = { resolveFamilyId, createParentMember, createChildMember, uploadIntakePhotos, parseArrayField };
