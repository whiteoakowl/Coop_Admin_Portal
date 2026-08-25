// Weekly Newsletter (Community & Commerce track, item 10) - content is
// auto-assembled from real, live tables (never hand-retyped by an
// admin), stored once generated so it can be edited before sending
// without the source data drifting under it. "Sending" is a status
// change only - see supabase/migrations/20260825100000_newsletter.sql's
// own header comment on why no real email provider is wired in here,
// same reasoning item 9 (Accounting/Payments) already established for
// stopping short of a real payment processor.
const db = require('../db');
const { sanitizePostBody } = require('./sanitizeHtml');
const notifications = require('./notifications');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Every section pulls straight from its own table's live rows - Events
// and Directory read from Track A/Track B's own utils rather than
// re-querying here, so this stays a single source of truth for "what
// counts as upcoming/active" as those modules evolve. Publications
// (handoff item 12) isn't built yet - its section is simply omitted
// rather than rendered as an empty placeholder, until that module
// exists to fill it.
async function assembleContent() {
  const parts = [];

  const events = await db.prepare("SELECT * FROM events WHERE status = 'published' AND starts_at >= now_text() ORDER BY starts_at LIMIT 5").all();
  if (events.length) {
    parts.push('<h2>Upcoming Events</h2><ul>' + events.map((e) => `<li><strong>${escapeHtml(e.title)}</strong> - ${escapeHtml(e.starts_at)}${e.location ? ' at ' + escapeHtml(e.location) : ''}</li>`).join('') + '</ul>');
  }

  // Registration/volunteer reminders - published, upcoming events that
  // still have open capacity or an unfilled volunteer role, re-derived
  // live the same way routes/events.js's own detail page does, never a
  // cached "spots left" number.
  const reminders = [];
  for (const e of events) {
    if (e.capacity != null) {
      const confirmed = Number((await db.prepare("SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'confirmed'").get(e.id)).c);
      if (confirmed < e.capacity) reminders.push(`${escapeHtml(e.title)} still has room - ${e.capacity - confirmed} spot(s) left.`);
    }
    const roles = await db.prepare('SELECT id, role_name, slots_needed FROM event_volunteer_roles WHERE event_id = ?').all(e.id);
    for (const role of roles) {
      const filled = Number((await db.prepare('SELECT COUNT(*) AS c FROM event_volunteer_signups WHERE volunteer_role_id = ?').get(role.id)).c);
      if (filled < role.slots_needed) reminders.push(`${escapeHtml(e.title)} needs volunteers for "${escapeHtml(role.role_name)}" (${role.slots_needed - filled} more needed).`);
    }
  }
  if (reminders.length) parts.push('<h2>Reminders</h2><ul>' + reminders.map((r) => `<li>${r}</li>`).join('') + '</ul>');

  const classes = await db.prepare('SELECT class_name, day, hour_position FROM classes ORDER BY day, hour_position, class_name').all();
  if (classes.length) {
    parts.push('<h2>This Week\'s Classes</h2><ul>' + classes.map((c) => `<li>${escapeHtml(c.class_name)} (${c.day === 'monday' ? 'Monday' : 'Wednesday'})</li>`).join('') + '</ul>');
  }

  const announcements = await db.prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 5").all();
  if (announcements.length) {
    parts.push('<h2>Announcements</h2><ul>' + announcements.map((a) => `<li><strong>${escapeHtml(a.title)}</strong> - ${escapeHtml(a.body)}</li>`).join('') + '</ul>');
  }

  const listings = await db.prepare("SELECT * FROM business_directory_listings WHERE status = 'active' ORDER BY created_at DESC LIMIT 5").all();
  if (listings.length) {
    parts.push('<h2>Business Directory</h2><ul>' + listings.map((l) => `<li><strong>${escapeHtml(l.business_name)}</strong>${l.category ? ' - ' + escapeHtml(l.category) : ''}</li>`).join('') + '</ul>');
  }

  return sanitizePostBody(parts.join('\n') || '<p>Nothing new to share this week.</p>');
}

async function listIssues() {
  return db.prepare('SELECT * FROM newsletter_issues ORDER BY created_at DESC').all();
}

async function getIssue(id) {
  return db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
}

async function createDraft(subject, accountId) {
  const bodyHtml = await assembleContent();
  const info = await db.prepare('INSERT INTO newsletter_issues (subject, body_html, created_by_account_id) VALUES (?, ?, ?)').run(subject, bodyHtml, accountId);
  return info.lastInsertRowid;
}

async function updateIssue(id, data) {
  await db.prepare('UPDATE newsletter_issues SET subject = ?, body_html = ?, updated_at = now_text() WHERE id = ?').run(data.subject, sanitizePostBody(data.bodyHtml), id);
}

// Regenerates body_html from live data, overwriting any hand edits - an
// explicit admin action ("Re-assemble from live data"), never automatic,
// so an admin's own edits are never silently discarded.
async function regenerate(id) {
  const bodyHtml = await assembleContent();
  await db.prepare('UPDATE newsletter_issues SET body_html = ?, updated_at = now_text() WHERE id = ?').run(bodyHtml, id);
}

async function scheduleIssue(id, scheduledAt) {
  await db.prepare("UPDATE newsletter_issues SET status = 'scheduled', scheduled_at = ?, updated_at = now_text() WHERE id = ?").run(scheduledAt, id);
}

async function unschedule(id) {
  await db.prepare("UPDATE newsletter_issues SET status = 'draft', scheduled_at = NULL, updated_at = now_text() WHERE id = ?").run(id);
}

// "Sent" is a status change recording who it would have reached, not a
// real email dispatch - see this file's own header comment. Each active
// account also gets a real notification through utils/notifications.js
// (item 11) - the Notification Center entry IS the "you have mail" a
// real send would have produced.
async function markSent(id) {
  const issue = await getIssue(id);
  const recipients = await db.prepare("SELECT id FROM member_accounts WHERE status = 'active'").all();
  await db.prepare("UPDATE newsletter_issues SET status = 'sent', sent_at = now_text(), recipient_count = ?, updated_at = now_text() WHERE id = ?").run(recipients.length, id);
  for (const recipient of recipients) {
    await notifications.notify(recipient.id, 'newsletter_sent', { title: issue.subject, body: 'A new newsletter issue is available.', linkUrl: `/newsletter/${id}` });
  }
}

async function deleteIssue(id) {
  await db.prepare('DELETE FROM newsletter_issues WHERE id = ?').run(id);
}

module.exports = {
  assembleContent,
  listIssues,
  getIssue,
  createDraft,
  updateIssue,
  regenerate,
  scheduleIssue,
  unschedule,
  markSent,
  deleteIssue,
};
