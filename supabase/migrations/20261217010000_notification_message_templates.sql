-- A real request: "Main admin portal and co-op admin portal settings
-- gear. Add a text/email notification settings card. There you can
-- change the default message for different things like floater
-- assignments, class wait list, event waitlist, event registration,
-- class registration, etc." utils/notifications.js's own notify() has
-- always taken a title/body the CALLER composes inline, hardcoded in
-- routes/utils - this is the first place any of that wording becomes
-- admin-editable. Deliberately a separate table from the existing
-- membership_letter_templates (Main Admin > Members > Settings >
-- Approval & Denial Messages) rather than folding into it - that one's
-- already a working, narrower (kind in ('approval','denial')) system
-- with its own route/UI; this is the general-purpose one for everything
-- else. Each row is a single real message a member could receive - a
-- type with two outcomes (confirmed/waitlisted, approved/rejected) gets
-- two rows, same "approval" + "denial" split membership_letter_templates
-- already established, rather than one row with if/else template logic.
create table if not exists notification_message_templates (
  template_key text primary key,
  subject text not null,
  body text not null,
  updated_at text not null default now_text()
);

-- {{placeholder}} substitution only (utils/notificationTemplates.js's own
-- render(), same plain regex-replace approach membership_letter_templates'
-- own renderTemplate() already uses - no conditional/loop syntax, so a
-- variable that happens to be blank for a given send (floater's own
-- hour/room, which aren't set on every assignment) leaves a visibly
-- empty gap in the template rather than silently reflowing the sentence.
-- Floater text is always admin-reviewed before it actually sends (the
-- Floater Assignments board's own Text Notify popup pre-fills this as a
-- STARTING point, never auto-sends it) so that gap is something the
-- admin can see and fix right there, not a silent production bug.
insert into notification_message_templates (template_key, subject, body) values
  ('floater_assignment_default', '', 'You''re assigned: {{position}} at {{hour}} in Room {{room}}.'),
  ('class_waitlist_promoted', 'Off the waitlist: {{className}}', 'A spot opened up - {{studentName}} is now confirmed for "{{className}}".'),
  ('class_registration_confirmed', 'Registered: {{className}}', '{{studentName}} is registered for "{{className}}".'),
  ('class_registration_waitlisted', '{{className}} is full', '{{className}} is full - {{studentName}} has been added to the waitlist (#{{waitlistPosition}}).'),
  ('event_registration_confirmed', 'Registered: {{eventTitle}}', '{{memberName}} is registered for "{{eventTitle}}".'),
  ('event_registration_waitlisted', '{{eventTitle}} is full', '{{eventTitle}} is full - {{memberName}} has been added to the waitlist (#{{waitlistPosition}}).'),
  ('event_waitlist_promoted', 'Off the waitlist: {{eventTitle}}', 'A spot opened up - {{memberName}} is now confirmed for "{{eventTitle}}".'),
  ('event_submission_decided_approved', 'Event approved: {{eventTitle}}', 'Your submitted event "{{eventTitle}}" was approved. A Main Admin still needs to publish it before it''s visible on the calendar.'),
  ('event_submission_decided_rejected', 'Event not approved: {{eventTitle}}', 'Your submitted event "{{eventTitle}}" was not approved.'),
  ('event_cancelled', 'Event Cancelled: {{eventTitle}}', '"{{eventTitle}}" has been cancelled.'),
  ('babysitter_submission_decided_approved', 'Babysitter profile approved', 'Your babysitter profile is now approved and visible in the directory.'),
  ('babysitter_submission_decided_rejected', 'Babysitter profile not approved', 'Your babysitter profile submission was not approved. Contact Main Admin for details.')
on conflict (template_key) do nothing;

-- class_registration didn't exist as its own notification_types row
-- before this - the direct (non-waitlist) class registration path never
-- called notify() at all, unlike event registration's own matching
-- event_registration type. auto_send_enabled defaults to 1 (on) like
-- every other type here.
insert into notification_types (key, label, description) values
  ('class_registration', 'Class Registration', 'Confirmation that a family member is registered for a class.')
on conflict (key) do nothing;
