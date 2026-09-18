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

// The 30-day lookback shared by the Business Directory and Classifieds
// sections below - "additions from the last 30 days," a real request -
// computed in SQL (not a JS Date passed in as a param) so it stays
// correct against the DB's own clock rather than the app server's.
const LAST_30_DAYS_SQL = "to_char(now() at time zone 'utc' - interval '30 days', 'YYYY-MM-DD HH24:MI:SS')";

// Every section pulls straight from its own table's live rows - Events,
// Directory, and Classifieds read from Track A/Track B's own utils
// rather than re-querying here, so this stays a single source of truth
// for "what counts as upcoming/active" as those modules evolve. Any
// section with nothing to show is simply omitted rather than rendered as
// an empty placeholder.
// The 4-week lookahead window "Upcoming Events" below uses - a real
// request: "don't show this week's classes. show the next 4 weeks of
// events from the event calendar." A plain date range instead of a fixed
// row count (the old "next 10 events" cap) so a busy month shows
// everything actually happening soon and a quiet one doesn't pad itself
// out with events well past 4 weeks away just to reach 10.
const FOUR_WEEKS_AHEAD_SQL = "to_char(now() at time zone 'utc' + interval '28 days', 'YYYY-MM-DD HH24:MI:SS')";

async function assembleContent() {
  const parts = [];

  const events = await db
    .prepare(`SELECT * FROM events WHERE status = 'published' AND starts_at >= now_text() AND starts_at <= ${FOUR_WEEKS_AHEAD_SQL} ORDER BY starts_at`)
    .all();
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

  const announcements = await db.prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 5").all();
  if (announcements.length) {
    parts.push('<h2>Announcements</h2><ul>' + announcements.map((a) => `<li><strong>${escapeHtml(a.title)}</strong> - ${escapeHtml(a.body)}</li>`).join('') + '</ul>');
  }

  // A real request: "business directory additions from the last 30
  // days" - every new listing in that window, not a fixed top-N, so a
  // slow week shows nothing and a busy one shows everything.
  const listings = await db
    .prepare(`SELECT l.*, c.title AS "categoryTitle" FROM business_directory_listings l LEFT JOIN business_directory_categories c ON c.id = l.category_id WHERE l.status = 'active' AND l.created_at >= ${LAST_30_DAYS_SQL} ORDER BY l.created_at DESC`)
    .all();
  if (listings.length) {
    parts.push('<h2>New in the Business Directory</h2><ul>' + listings.map((l) => `<li><strong>${escapeHtml(l.business_name)}</strong>${l.categoryTitle ? ' - ' + escapeHtml(l.categoryTitle) : ''}</li>`).join('') + '</ul>');
  }

  // A real request: "classifieds from the last 30 days" - same window
  // and reasoning as the Business Directory section above.
  const classifieds = await db
    .prepare(`SELECT l.*, c.title AS "categoryTitle" FROM classified_listings l LEFT JOIN classified_categories c ON c.id = l.category_id WHERE l.status = 'active' AND l.created_at >= ${LAST_30_DAYS_SQL} ORDER BY l.created_at DESC`)
    .all();
  if (classifieds.length) {
    parts.push('<h2>New Classifieds</h2><ul>' + classifieds.map((l) => `<li><strong>${escapeHtml(l.title)}</strong>${l.price ? ' - ' + escapeHtml(l.price) : ''}${l.categoryTitle ? ' (' + escapeHtml(l.categoryTitle) + ')' : ''}</li>`).join('') + '</ul>');
  }

  // Only public publications - a members-only article summarized in an
  // email a signed-out family member might see would defeat its own
  // visibility setting.
  const publications = await db.prepare("SELECT * FROM publications WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC LIMIT 5").all();
  if (publications.length) {
    parts.push('<h2>Publications</h2><ul>' + publications.map((p) => `<li><strong>${escapeHtml(p.title)}</strong></li>`).join('') + '</ul>');
  }

  // A real request: "quick links for absence form and name tag form."
  // Unlike every section above, always present regardless of live data -
  // these are standing, evergreen links, not something that ever has
  // "nothing to show."
  parts.push('<h2>Quick Links</h2><ul><li><a href="/absence">Absence/Late Form</a></li><li><a href="/name-tag">Name Tag Form</a></li></ul>');

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

// A real request: "Add a 'Customize Newsletter' action where admin
// writes their own note/letter that appears before the automatic
// content." Its own column and its own save action, deliberately
// separate from updateIssue's body_html.
async function setCustomNote(id, note) {
  await db.prepare('UPDATE newsletter_issues SET custom_note = ?, updated_at = now_text() WHERE id = ?').run(sanitizePostBody(note || ''), id);
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
  setCustomNote,
  scheduleIssue,
  unschedule,
  markSent,
  deleteIssue,
};
