// Admin-editable default message text for the automated notifications
// utils/notifications.js's own notify() sends - a real request: "Add a
// text/email notification settings card [to both Settings gears]. There
// you can change the default message for different things like floater
// assignments, class wait list, event waitlist, event registration,
// class registration, etc." Before this, every call site composed its
// own title/body inline in code - this is the first place any of that
// wording is admin-editable, stored in notification_message_templates
// (see that migration's own header comment for why it's a separate
// table from membership_letter_templates, and why a type with two real
// outcomes - confirmed/waitlisted, approved/rejected - gets two rows
// instead of one row with if/else template logic).
const db = require('../db');

// One entry per row in notification_message_templates. `group` is the
// settings page's own section heading; `placeholders` is shown there as
// a hint, never enforced - an admin can leave one out or use it twice,
// same as membership_letter_templates' own {{name}} today.
const TEMPLATE_DEFINITIONS = {
  floater_assignment_default: {
    label: 'Starting text (editable before every send)',
    group: 'Floater Assignments',
    hasSubject: false,
    placeholders: ['position', 'hour', 'room'],
  },
  class_waitlist_promoted: {
    label: 'Moved off the waitlist',
    group: 'Class Waitlist',
    hasSubject: true,
    placeholders: ['className', 'studentName'],
  },
  class_registration_confirmed: {
    label: 'Registration confirmed',
    group: 'Class Registration',
    hasSubject: true,
    placeholders: ['className', 'studentName'],
  },
  class_registration_waitlisted: {
    label: 'Class full - added to waitlist',
    group: 'Class Registration',
    hasSubject: true,
    placeholders: ['className', 'studentName', 'waitlistPosition'],
  },
  event_registration_confirmed: {
    label: 'Registration confirmed',
    group: 'Event Registration',
    hasSubject: true,
    placeholders: ['eventTitle', 'memberName'],
  },
  event_registration_waitlisted: {
    label: 'Event full - added to waitlist',
    group: 'Event Registration',
    hasSubject: true,
    placeholders: ['eventTitle', 'memberName', 'waitlistPosition'],
  },
  event_waitlist_promoted: {
    label: 'Moved off the waitlist',
    group: 'Event Waitlist',
    hasSubject: true,
    placeholders: ['eventTitle', 'memberName'],
  },
  event_submission_decided_approved: {
    label: 'Submitted event approved',
    group: 'Event Submissions',
    hasSubject: true,
    placeholders: ['eventTitle'],
  },
  event_submission_decided_rejected: {
    label: 'Submitted event not approved',
    group: 'Event Submissions',
    hasSubject: true,
    placeholders: ['eventTitle'],
  },
  event_cancelled: {
    label: 'Event cancelled',
    group: 'Event Cancellation',
    hasSubject: true,
    placeholders: ['eventTitle'],
  },
  babysitter_submission_decided_approved: {
    label: 'Babysitter profile approved',
    group: 'Babysitter Profiles',
    hasSubject: true,
    placeholders: [],
  },
  babysitter_submission_decided_rejected: {
    label: 'Babysitter profile not approved',
    group: 'Babysitter Profiles',
    hasSubject: true,
    placeholders: [],
  },
};

async function allTemplates() {
  const rows = await db.prepare('SELECT * FROM notification_message_templates').all();
  const byKey = {};
  for (const r of rows) byKey[r.template_key] = r;
  return Object.keys(TEMPLATE_DEFINITIONS).map((templateKey) => ({
    templateKey,
    ...TEMPLATE_DEFINITIONS[templateKey],
    subject: byKey[templateKey]?.subject ?? '',
    body: byKey[templateKey]?.body ?? '',
  }));
}

async function getTemplate(templateKey) {
  if (!TEMPLATE_DEFINITIONS[templateKey]) return null;
  return db.prepare('SELECT * FROM notification_message_templates WHERE template_key = ?').get(templateKey);
}

async function updateTemplate(templateKey, subject, body) {
  if (!TEMPLATE_DEFINITIONS[templateKey]) return;
  await db
    .prepare('UPDATE notification_message_templates SET subject = ?, body = ?, updated_at = now_text() WHERE template_key = ?')
    .run(subject || '', body || '', templateKey);
}

// Plain {{placeholder}} substitution, same regex-replace approach
// membership_letter_templates' own renderTemplate() already uses - see
// the migration's own header comment on why this stays simple (no
// conditionals) rather than growing a mini template language.
function fillPlaceholders(text, vars) {
  return (text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match));
}

// Renders a stored template with the given variables. Returns
// { subject, body } - subject is '' for a template with hasSubject:
// false (floater_assignment_default, which has no title field at all,
// just the one SMS-length text box).
async function renderTemplate(templateKey, vars = {}) {
  const row = await getTemplate(templateKey);
  if (!row) throw new Error(`Unknown notification message template: ${templateKey}`);
  return { subject: fillPlaceholders(row.subject, vars), body: fillPlaceholders(row.body, vars) };
}

module.exports = { TEMPLATE_DEFINITIONS, allTemplates, getTemplate, updateTemplate, renderTemplate, fillPlaceholders };
