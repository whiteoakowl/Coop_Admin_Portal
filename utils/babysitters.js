// Babysitter Directory - shared helpers behind Parent Portal (create/
// edit a profile for one of their own children, browse the directory),
// Student Portal (create/edit their own profile), and Main Admin's own
// approval queue (routes/main-admin-babysitters.js). See the migration's
// own header comment (supabase/migrations/20260827030000_babysitter_
// directory.sql) for why every submission AND every edit resets a
// profile back to 'pending'.
const db = require('../db');
const notifications = require('./notifications');
const { byLastName } = require('./members');

async function profileForMember(memberId) {
  return db.prepare('SELECT * FROM babysitter_profiles WHERE member_id = ?').get(memberId);
}

// The public-facing directory - only ever 'approved' profiles, joined
// with the member's own name/type so the directory doesn't have to do a
// second lookup per row. Sorted by last name, same as every other list
// in this app (utils/members.js's own byLastName).
async function listApprovedProfiles() {
  const rows = await db
    .prepare(
      `SELECT bp.*, m.name AS member_name, m.name AS name, m.member_type
       FROM babysitter_profiles bp
       JOIN members m ON m.id = bp.member_id
       WHERE bp.status = 'approved'`
    )
    .all();
  return rows.sort(byLastName);
}

// Main Admin's own approval queue - every profile, pending first so
// there's always something to act on at the top.
async function listAllProfiles() {
  const rows = await db
    .prepare(
      `SELECT bp.*, m.name AS member_name, m.member_type
       FROM babysitter_profiles bp
       JOIN members m ON m.id = bp.member_id
       ORDER BY CASE bp.status WHEN 'pending' THEN 0 ELSE 1 END, bp.updated_at DESC`
    )
    .all();
  return rows;
}

// Create or edit - one profile per member, so this is an upsert. Either
// way the result goes back to 'pending', even a plain edit of an already
// -approved profile (confirmed with the requester: "every submission and
// edit" needs Main Admin's review, not just the first one).
async function submitProfile(memberId, data, accountId) {
  const existing = await profileForMember(memberId);
  if (existing) {
    await db
      .prepare(
        `UPDATE babysitter_profiles
         SET age_grade = ?, availability = ?, experience = ?, certifications = ?, hourly_rate = ?, contact_method = ?,
             photo_key = COALESCE(?, photo_key), status = 'pending', submitted_by_account_id = ?, decided_at = NULL, updated_at = now_text()
         WHERE member_id = ?`
      )
      .run(data.ageGrade, data.availability, data.experience, data.certifications, data.hourlyRate, data.contactMethod, data.photoKey || null, accountId, memberId);
    return existing.id;
  }
  const info = await db
    .prepare(
      `INSERT INTO babysitter_profiles
         (member_id, age_grade, availability, experience, certifications, hourly_rate, contact_method, photo_key, submitted_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, data.ageGrade, data.availability, data.experience, data.certifications, data.hourlyRate, data.contactMethod, data.photoKey || null, accountId);
  return info.lastInsertRowid;
}

async function decideSubmission(id, approve) {
  const profile = await db.prepare('SELECT * FROM babysitter_profiles WHERE id = ?').get(id);
  if (!profile || profile.status !== 'pending') return null;
  await db
    .prepare("UPDATE babysitter_profiles SET status = ?, decided_at = now_text(), updated_at = now_text() WHERE id = ?")
    .run(approve ? 'approved' : 'rejected', id);
  if (profile.submitted_by_account_id) {
    await notifications.notify(profile.submitted_by_account_id, 'babysitter_submission_decided', {
      title: approve ? 'Babysitter profile approved' : 'Babysitter profile not approved',
      body: approve
        ? 'Your babysitter profile is now approved and visible in the directory.'
        : 'Your babysitter profile submission was not approved. Contact Main Admin for details.',
      linkUrl: '/parent/babysitters',
    });
  }
  return approve ? 'approved' : 'rejected';
}

module.exports = { profileForMember, listApprovedProfiles, listAllProfiles, submitProfile, decideSubmission };
