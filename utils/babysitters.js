// Babysitter Directory - shared helpers behind Parent Portal (create/
// edit a profile for one of their own children, browse the directory),
// Student Portal (create/edit their own profile), and Main Admin's own
// Babysitter/Approvals/Settings tabs (routes/main-admin-babysitters.js).
// See the migration's own header comment (supabase/migrations/
// 20260827030000_babysitter_directory.sql) for why every submission AND
// every edit resets a profile back to 'pending' by default - Main Admin
// can turn that off in Settings (requireApprovalSetting below), a real
// request: "babysitter tab should have babysitter, approvals and
// settings tab."
const db = require('../db');
const notifications = require('./notifications');
const { byLastName } = require('./members');
const { appSetting, setAppSetting } = require('./classSchedule');

const REQUIRE_APPROVAL_KEY = 'babysitter_require_approval';

async function requireApprovalSetting() {
  return (await appSetting(REQUIRE_APPROVAL_KEY, '1')) === '1';
}

async function setRequireApprovalSetting(enabled) {
  await setAppSetting(REQUIRE_APPROVAL_KEY, enabled ? '1' : '0');
}

async function profileForMember(memberId) {
  return db.prepare('SELECT * FROM babysitter_profiles WHERE member_id = ?').get(memberId);
}

// The public-facing directory - only ever 'approved' profiles, joined
// with the member's own name/phone (a real request: "directory should be
// cards... photo, name, grade and phone number") so the directory view
// doesn't need a second lookup per row. Sorted by last name, same as
// every other list in this app (utils/members.js's own byLastName).
async function listApprovedProfiles() {
  const rows = await db
    .prepare(
      `SELECT bp.*, m.name AS member_name, m.name AS name, m.member_type, m.phone AS member_phone
       FROM babysitter_profiles bp
       JOIN members m ON m.id = bp.member_id
       WHERE bp.status = 'approved'`
    )
    .all();
  return rows.sort(byLastName);
}

// Main Admin's own Approvals tab - pending submissions only (a decided
// one, approved or rejected, has nothing left to act on - approved ones
// already show in the directory, rejected ones are done).
async function listPendingProfiles() {
  const rows = await db
    .prepare(
      `SELECT bp.*, m.name AS member_name, m.member_type
       FROM babysitter_profiles bp
       JOIN members m ON m.id = bp.member_id
       WHERE bp.status = 'pending'
       ORDER BY bp.updated_at ASC`
    )
    .all();
  return rows;
}

// The member picker behind Main Admin's own "+ Add Babysitter Profile"
// popup - a real request: "add a babysitter profile button that pops up
// and picks a member, auto fills the rest of the form." Every active
// member is eligible (a family's teen or the student themselves, same as
// the member-facing submission forms) - grade_level/phone travel along so
// the popup's own JS can autofill without a second request per pick.
async function listMembersForPicker() {
  const rows = await db.prepare("SELECT id, name, grade_level, phone FROM members WHERE active = 1").all();
  return rows.sort(byLastName);
}

// Create or edit - one profile per member, so this is an upsert. A plain
// member submission/edit resets to 'pending' unless Main Admin has turned
// off the approval requirement in Settings, in which case it's approved
// immediately - see requireApprovalSetting above.
async function submitProfile(memberId, data, accountId) {
  const requireApproval = await requireApprovalSetting();
  const status = requireApproval ? 'pending' : 'approved';
  const decidedAt = requireApproval ? null : 'now_text()';
  const existing = await profileForMember(memberId);
  if (existing) {
    await db
      .prepare(
        `UPDATE babysitter_profiles
         SET age_grade = ?, availability = ?, experience = ?, certifications = ?, hourly_rate = ?, contact_method = ?, contact_preference = ?,
             photo_key = COALESCE(?, photo_key), status = ?, submitted_by_account_id = ?, decided_at = ${decidedAt || 'NULL'}, updated_at = now_text()
         WHERE member_id = ?`
      )
      .run(data.ageGrade, data.availability, data.experience, data.certifications, data.hourlyRate, data.contactMethod, data.contactPreference || null, data.photoKey || null, status, accountId, memberId);
    return existing.id;
  }
  const info = await db
    .prepare(
      `INSERT INTO babysitter_profiles
         (member_id, age_grade, availability, experience, certifications, hourly_rate, contact_method, contact_preference, photo_key, status, submitted_by_account_id, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${decidedAt || 'NULL'}) RETURNING id`
    )
    .get(memberId, data.ageGrade, data.availability, data.experience, data.certifications, data.hourlyRate, data.contactMethod, data.contactPreference || null, data.photoKey || null, status, accountId);
  return info.id;
}

// Main Admin adding a profile directly (not a member's own submission) -
// always lands 'approved' right away, same "an admin-added row skips the
// review queue" convention utils/resourceLinks.js's own createResourceLink
// already uses.
async function createProfileByAdmin(memberId, data, accountId) {
  const existing = await profileForMember(memberId);
  if (existing) {
    await db
      .prepare(
        `UPDATE babysitter_profiles
         SET age_grade = ?, availability = ?, experience = ?, certifications = ?, hourly_rate = ?, contact_method = ?, contact_preference = ?,
             photo_key = COALESCE(?, photo_key), status = 'approved', submitted_by_account_id = ?, decided_at = now_text(), updated_at = now_text()
         WHERE member_id = ?`
      )
      .run(data.ageGrade, data.availability, data.experience, data.certifications, data.hourlyRate, data.contactMethod, data.contactPreference || null, data.photoKey || null, accountId, memberId);
    return existing.id;
  }
  const info = await db
    .prepare(
      `INSERT INTO babysitter_profiles
         (member_id, age_grade, availability, experience, certifications, hourly_rate, contact_method, contact_preference, photo_key, status, submitted_by_account_id, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, now_text()) RETURNING id`
    )
    .get(memberId, data.ageGrade, data.availability, data.experience, data.certifications, data.hourlyRate, data.contactMethod, data.contactPreference || null, data.photoKey || null, accountId);
  return info.id;
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

module.exports = {
  profileForMember,
  listApprovedProfiles,
  listPendingProfiles,
  listMembersForPicker,
  submitProfile,
  createProfileByAdmin,
  decideSubmission,
  requireApprovalSetting,
  setRequireApprovalSetting,
};
