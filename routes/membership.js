const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { imageFileFilter } = require('../utils/uploads');
const { GRADE_OPTIONS, VOLUNTEER_INTEREST_OPTIONS } = require('../utils/membership');
const { isValidISODate } = require('../utils/dates');

// Despite living outside the /admin URL prefix (unchanged here to avoid
// disturbing anything that already links to /membership), this form is
// admin-only, not public - an admin fills it out on a family's behalf
// (from a paper form, a phone call, etc.), the same as adding a member
// directly. It's not one of the app's genuine public forms (absence,
// name-tag), which stay open with no login because a parent submits
// those themselves.
//
// requireFullAdmin is applied per-route below, NOT as a router-level
// `router.use(...)` here - this router is mounted at the site root ('/',
// alongside the app's actually-public routers), not under '/admin' like
// the other requireFullAdmin-gated routers (Documents, Library, Design,
// Members, misc badges, Name Tag - see server.js's own mounting-order
// comment). A path-less `router.use()` on a root-mounted router matches
// every request the app receives, not just this router's own routes -
// it would intercept /admin/login itself, along with everything else.

const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'membership-children');
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.get('/membership', requireFullAdmin, (req, res) => {
  res.render('membership', {
    title: 'Membership Form',
    gradeOptions: GRADE_OPTIONS,
    volunteerOptions: VOLUNTEER_INTEREST_OPTIONS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// multer parses "children[0][firstName]" style multipart fields into a real
// (possibly sparse, if a child block was removed client-side) nested array
// on req.body.children, so the array index already lines up with the
// original bracket index used in uploaded file fieldnames below.
function parseChildren(body) {
  if (Array.isArray(body.children)) return body.children;
  if (body.children && typeof body.children === 'object') {
    return Object.keys(body.children).map((k) => body.children[k]);
  }
  return [];
}

router.post('/membership', requireFullAdmin, upload.any(), async (req, res) => {
  const body = req.body;
  const parent1FirstName = (body.parent1FirstName || '').trim();
  const parent1LastName = (body.parent1LastName || '').trim();
  const parent1Email = (body.parent1Email || '').trim();

  if (!parent1FirstName || !parent1LastName || !parent1Email) {
    return res.redirect('/membership?error=' + encodeURIComponent('Parent/Guardian #1 name and email are required.'));
  }

  const children = parseChildren(body)
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c && (c.firstName || '').trim() && (c.lastName || '').trim());

  if (children.length === 0) {
    return res.redirect('/membership?error=' + encodeURIComponent('Please add at least one child.'));
  }

  const volunteerInterests = [].concat(body.volunteerInterests || []).filter((v) => VOLUNTEER_INTEREST_OPTIONS.includes(v));

  const info = await db
    .prepare(
      `INSERT INTO membership_requests
        (parent1_first_name, parent1_last_name, parent1_email, parent1_phone,
         parent2_first_name, parent2_last_name, parent2_email, parent2_phone,
         address, city, state, zipcode, volunteer_interests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parent1FirstName,
      parent1LastName,
      parent1Email,
      (body.parent1Phone || '').trim() || null,
      (body.parent2FirstName || '').trim() || null,
      (body.parent2LastName || '').trim() || null,
      (body.parent2Email || '').trim() || null,
      (body.parent2Phone || '').trim() || null,
      (body.address || '').trim() || null,
      (body.city || '').trim() || null,
      (body.state || '').trim() || null,
      (body.zipcode || '').trim() || null,
      volunteerInterests.join(', ') || null
    );

  const requestId = info.lastInsertRowid;
  const insertChild = db.prepare(
    `INSERT INTO membership_request_children (request_id, first_name, last_name, birthdate, grade_level, medical_notes, photo_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const c of children) {
    const photoFile = (req.files || []).find((f) => f.fieldname === `children[${c.index}][photo]`);
    await insertChild.run(
      requestId,
      c.firstName.trim(),
      c.lastName.trim(),
      // Silently dropped rather than rejecting the whole submission - a
      // malformed birthdate here isn't fatal, it just leaves this one
      // field blank for the admin to fill in when approving the request
      // (see ageFromBirthday's own isValidISODate guard for why this
      // needs to already be a real date by the time it becomes a
      // member's birthday, not just by the time it's displayed).
      isValidISODate((c.birthdate || '').trim()) ? c.birthdate.trim() : null,
      GRADE_OPTIONS.includes(c.gradeLevel) ? c.gradeLevel : null,
      (c.medicalNotes || '').trim() || null,
      photoFile ? `/uploads/membership-children/${photoFile.filename}` : null
    );
  }

  res.redirect('/membership?notice=' + encodeURIComponent('Thanks! Your membership request has been submitted.'));
});

module.exports = router;
