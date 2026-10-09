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
const { listActiveClassDays, classesWithOpenStaffSlotsForDay } = require('./classSchedule');
const { getActiveKioskSemesterId } = require('./kioskSettings');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

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

  // A real request: "it should show a list of classes still needing a
  // teacher or assistant" (explicitly NOT a general upcoming-classes
  // schedule - just the unstaffed ones) - the exact same live
  // classesWithOpenStaffSlotsForDay (utils/classSchedule.js) the Co-op
  // Classes page's own "Classes Needing a Teacher or Assistant" button
  // already uses, just flattened across every active day instead of
  // one day at a time.
  const staffingNeeds = [];
  const activeSemesterId = await getActiveKioskSemesterId();
  for (const day of await listActiveClassDays()) {
    const hours = await classesWithOpenStaffSlotsForDay(day, activeSemesterId);
    for (const hour of hours) {
      for (const cls of hour.classes) {
        const roles = [];
        if (cls.teacherNeeded > 0) roles.push('teacher');
        if (cls.assistantNeeded > 0) roles.push('assistant');
        staffingNeeds.push(`<strong>${escapeHtml(cls.class_name)}</strong> (${escapeHtml(day.charAt(0).toUpperCase() + day.slice(1))}) - needs a ${roles.join(' and ')}.`);
      }
    }
  }
  if (staffingNeeds.length) {
    parts.push('<h2>Classes Needing a Teacher or Assistant</h2><ul>' + staffingNeeds.map((s) => `<li>${s}</li>`).join('') + '</ul>');
  }

  // Only public publications - a members-only article summarized in an
  // email a signed-out family member might see would defeat its own
  // visibility setting.
  const publications = await db.prepare("SELECT * FROM publications WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC LIMIT 5").all();
  if (publications.length) {
    parts.push('<h2>Publications</h2><ul>' + publications.map((p) => `<li><strong>${escapeHtml(p.title)}</strong></li>`).join('') + '</ul>');
  }

  // A real request: "a button for business directory view and view
  // classifieds. Button for join a committee." Standing links to those
  // pages themselves (where everything active already lists live),
  // replacing the old separate "New in the last 30 days" listings here -
  // always present, not conditioned on anything new existing this week.
  parts.push(
    '<h2>Get Involved</h2><ul>' +
      '<li><a href="/directory">View Business Directory</a></li>' +
      '<li><a href="/classifieds">View Classifieds</a></li>' +
      '<li><a href="/committees">Join a Committee</a></li>' +
      '</ul>'
  );

  // A real request: "co-op section with a button for the absence/late
  // form and a button for the name tag form" - its own labeled section,
  // separate from Get Involved above. Always present, same "standing
  // link, never conditioned on live data" reasoning as Get Involved.
  parts.push('<h2>Co-op</h2><ul><li><a href="/absence">Absence/Late Form</a></li><li><a href="/name-tag">Name Tag Form</a></li></ul>');

  return sanitizePostBody(parts.join('\n') || '<p>Nothing new to share this week.</p>');
}

async function listIssues() {
  return db.prepare('SELECT * FROM newsletter_issues ORDER BY created_at DESC').all();
}

// A real request: "check box under send automatically every week for
// send newsletter immediately for a quick one time send out off
// schedule." There's no issue selected on the schedule page itself, so
// "send newsletter immediately" acts on the most recently created
// issue that hasn't gone out yet - the one a weekly auto-send would
// have picked up next.
async function mostRecentUnsentIssue() {
  return db.prepare("SELECT * FROM newsletter_issues WHERE status IN ('draft', 'scheduled') ORDER BY created_at DESC, id DESC LIMIT 1").get();
}

async function getIssue(id) {
  return db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
}

async function createDraft(subject, accountId) {
  const bodyHtml = await assembleContent();
  const info = await db.prepare('INSERT INTO newsletter_issues (subject, body_html, created_by_account_id) VALUES (?, ?, ?)').run(subject, bodyHtml, accountId);
  return info.lastInsertRowid;
}

// A real request: "why are there two editing feature boxes on
// newsletter there should only be one for writing the main message" -
// custom_note (now labeled "Newsletter Message") is the one editable
// field left; body_html stays exactly as assembleContent() produced it
// at createDraft time, never rewritten by an admin edit again.
async function updateIssue(id, data) {
  await db.prepare('UPDATE newsletter_issues SET subject = ?, custom_note = ?, updated_at = now_text() WHERE id = ?').run(data.subject, sanitizePostBody(data.customNote || ''), id);
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
  mostRecentUnsentIssue,
  getIssue,
  createDraft,
  updateIssue,
  scheduleIssue,
  unschedule,
  markSent,
  deleteIssue,
};
