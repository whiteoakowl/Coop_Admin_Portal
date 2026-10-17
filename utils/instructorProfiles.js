// Instructor profiles (supabase/migrations/20261121010000_instructor_profiles.sql) -
// an admin-managed, optionally teacher-self-edited bio for a member who's
// ever been staffed as a teacher/assistant on a class. One row per member
// who's actually been touched by this feature; a member with no row yet
// just reads as "disabled, every field blank" (see the LEFT JOIN/default
// shape below), not an error.
const db = require('../db');

async function instructorProfile(memberId) {
  return db.prepare('SELECT * FROM instructor_profiles WHERE member_id = ?').get(memberId);
}

// Batch version for the admin Instructor Profiles list - one query for
// every row shown instead of one per member, same N+1 avoidance as
// utils/sections.js's own classSectionIdsForClasses.
async function instructorProfilesByMemberIds(memberIds) {
  if (memberIds.length === 0) return {};
  const placeholders = memberIds.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT * FROM instructor_profiles WHERE member_id IN (${placeholders})`).all(...memberIds);
  const byId = {};
  for (const r of rows) byId[r.member_id] = r;
  return byId;
}

// The admin's own Instructor Profiles list "check mark for enable/disable"
// column - deliberately touches ONLY enabled, never the email/phone/about
// me/qualifications fields a save from the edit form (below) writes, so
// toggling it on/off can never clobber what's already been filled in
// either direction (admin edits the fields, then flips Enable - or flips
// Enable first, then edits - either order lands on the same end state).
async function setInstructorProfileEnabled(memberId, enabled) {
  await db
    .prepare(
      `INSERT INTO instructor_profiles (member_id, enabled) VALUES (?, ?)
       ON CONFLICT (member_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now_text()`
    )
    .run(memberId, enabled ? 1 : 0);
}

// The edit form (admin-side AND the teacher's own Teacher Portal self-edit,
// both routes/admin-teachers.js and routes/teacher-portal.js save through
// this same function) - deliberately never touches `enabled`, which only
// setInstructorProfileEnabled above (admin-only) ever changes. A teacher
// editing their own bio can't accidentally re-enable/disable themselves.
async function saveInstructorProfile(memberId, fields) {
  await db
    .prepare(
      `INSERT INTO instructor_profiles (member_id, email, phone, about_me, qualifications, qualifications_visible)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (member_id) DO UPDATE SET
         email = EXCLUDED.email, phone = EXCLUDED.phone, about_me = EXCLUDED.about_me,
         qualifications = EXCLUDED.qualifications, qualifications_visible = EXCLUDED.qualifications_visible,
         updated_at = now_text()`
    )
    .run(memberId, fields.email || null, fields.phone || null, fields.aboutMe || null, fields.qualifications || null, fields.qualificationsVisible ? 1 : 0);
}

module.exports = { instructorProfile, instructorProfilesByMemberIds, setInstructorProfileEnabled, saveInstructorProfile };
