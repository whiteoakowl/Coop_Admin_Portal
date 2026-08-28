// Shared logic behind both portals' Communication > Email tab (item 12) -
// a real request: "filter that filters the member list by section, role,
// if they're registered for classes or not, age group, grade level,
// parent, student, teacher etc... select all, select none... create
// email button takes you to a new screen where you can compose... option
// to send right away or schedule for later." Filtering/select-all/select-
// none happen client-side against the full candidate list this module
// returns (small member counts for a homeschool co-op - no pagination
// needed); scheduling and the actual "send" reuse the same
// notify()-through-notification_types plumbing utils/announcements.js and
// utils/newsletter.js already use, and mirror newsletter_issues' own
// status/scheduled_at/sent_at shape (see this feature's own migration
// comment on why a scheduled send doesn't dispatch on its own).
const db = require('../db');
const { notify } = require('./notifications');

const AGE_GROUPS = [
  { key: 'under5', label: 'Under 5', min: 0, max: 4 },
  { key: '5-8', label: '5 to 8', min: 5, max: 8 },
  { key: '9-12', label: '9 to 12', min: 9, max: 12 },
  { key: '13-18', label: '13 to 18', min: 13, max: 18 },
  { key: '19plus', label: '19+', min: 19, max: 200 },
];

function ageFromBirthday(birthday) {
  if (!birthday) return null;
  const dob = new Date(birthday);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function ageGroupKeyForBirthday(birthday) {
  const age = ageFromBirthday(birthday);
  if (age == null) return null;
  const group = AGE_GROUPS.find((g) => age >= g.min && age <= g.max);
  return group ? group.key : null;
}

async function listRoles() {
  return db.prepare('SELECT key, label FROM roles ORDER BY label').all();
}

async function listSections() {
  return db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
}

async function listGradeLevels() {
  const rows = await db.prepare("SELECT DISTINCT grade_level FROM members WHERE grade_level IS NOT NULL AND grade_level <> '' ORDER BY grade_level").all();
  return rows.map((r) => r.grade_level);
}

// Every active portal account, with the roster/section/registration
// detail the filter popup and member-list table both need. Filtering
// itself happens against this full list (role/section/gradeLevel/
// ageGroup/registered), not in SQL - see this file's own header comment
// on why (small candidate counts, and several of the facets - age group,
// registration status - are cheapest to compute here rather than as
// several more JOINs).
async function listRecipientCandidates() {
  const rows = await db
    .prepare(
      `SELECT ma.id AS account_id, ma.email, m.id AS member_id, m.name, m.member_type, m.grade_level, m.birthday
       FROM member_accounts ma
       JOIN members m ON m.id = ma.member_id
       WHERE ma.status = 'active'
       ORDER BY LOWER(m.name)`
    )
    .all();
  if (rows.length === 0) return [];

  const memberIds = rows.map((r) => r.member_id);
  const accountIds = rows.map((r) => r.account_id);

  const roleRows = await db
    .prepare(`SELECT mar.member_account_id, r.key AS role_key FROM member_account_roles mar JOIN roles r ON r.id = mar.role_id WHERE mar.member_account_id IN (${accountIds.map(() => '?').join(',')})`)
    .all(...accountIds);
  const rolesByAccount = new Map();
  roleRows.forEach((r) => {
    if (!rolesByAccount.has(r.member_account_id)) rolesByAccount.set(r.member_account_id, []);
    rolesByAccount.get(r.member_account_id).push(r.role_key);
  });

  const sectionRows = await db
    .prepare(`SELECT ms.member_id, s.name AS section_name FROM member_sections ms JOIN sections s ON s.id = ms.section_id WHERE ms.member_id IN (${memberIds.map(() => '?').join(',')})`)
    .all(...memberIds);
  const sectionsByMember = new Map();
  sectionRows.forEach((r) => {
    if (!sectionsByMember.has(r.member_id)) sectionsByMember.set(r.member_id, []);
    sectionsByMember.get(r.member_id).push(r.section_name);
  });

  const registrationRows = await db
    .prepare(`SELECT DISTINCT student_id FROM class_registrations WHERE status IN ('confirmed', 'waitlisted') AND student_id IN (${memberIds.map(() => '?').join(',')})`)
    .all(...memberIds);
  const registeredMemberIds = new Set(registrationRows.map((r) => r.student_id));

  return rows.map((r) => ({
    accountId: r.account_id,
    email: r.email,
    memberId: r.member_id,
    name: r.name,
    memberType: r.member_type,
    gradeLevel: r.grade_level,
    roles: rolesByAccount.get(r.account_id) || [],
    sections: sectionsByMember.get(r.member_id) || [],
    ageGroup: ageGroupKeyForBirthday(r.birthday),
    registeredForClasses: registeredMemberIds.has(r.member_id),
  }));
}

async function createAndSend({ subject, bodyHtml, replyTo, recipientAccountIds, sentByAccountId, sentByPortal }) {
  const recipients = [...new Set(recipientAccountIds)];
  for (const accountId of recipients) {
    await notify(accountId, 'email_campaign', { title: subject, body: bodyHtml });
  }
  const info = await db
    .prepare(
      `INSERT INTO email_campaigns (subject, body_html, reply_to, recipient_account_ids, recipient_count, status, sent_at, sent_by_portal, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, 'sent', now_text(), ?, ?) RETURNING id`
    )
    .get(subject, bodyHtml, replyTo || null, JSON.stringify(recipients), recipients.length, sentByPortal, sentByAccountId);
  return { id: info.id, recipientCount: recipients.length };
}

async function createScheduled({ subject, bodyHtml, replyTo, recipientAccountIds, scheduledAt, sentByAccountId, sentByPortal }) {
  const recipients = [...new Set(recipientAccountIds)];
  const info = await db
    .prepare(
      `INSERT INTO email_campaigns (subject, body_html, reply_to, recipient_account_ids, recipient_count, status, scheduled_at, sent_by_portal, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?) RETURNING id`
    )
    .get(subject, bodyHtml, replyTo || null, JSON.stringify(recipients), recipients.length, scheduledAt, sentByPortal, sentByAccountId);
  return { id: info.id, recipientCount: recipients.length };
}

// Manually dispatches an already-scheduled campaign - the same "Schedule
// saves it, an admin still has to press Send" pattern utils/newsletter.js's
// own markSent() already established, since nothing in this app actually
// wakes up and sends things on a timer (see the migration's own comment).
async function sendScheduled(id) {
  const campaign = await db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(id);
  if (!campaign || campaign.status === 'sent') return null;
  const recipients = JSON.parse(campaign.recipient_account_ids || '[]');
  for (const accountId of recipients) {
    await notify(accountId, 'email_campaign', { title: campaign.subject, body: campaign.body_html });
  }
  await db.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = now_text() WHERE id = ?").run(id);
  return campaign;
}

async function listCampaigns(limit = 25) {
  return db.prepare('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
  AGE_GROUPS,
  listRoles,
  listSections,
  listGradeLevels,
  listRecipientCandidates,
  createAndSend,
  createScheduled,
  sendScheduled,
  listCampaigns,
};
