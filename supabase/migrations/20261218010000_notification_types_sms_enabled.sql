-- A real request: "Class/event wait list or registration, event or
-- class submission decision, babysitters decision, forum reply,
-- announcements, newsletter sent, should be email notifications, not
-- text." sms_enabled is a type-level switch (unlike notification_
-- preferences, which is an account's own per-type override) - a member
-- can still turn SMS back on for a type in their own Preferences, but
-- utils/notifications.js's own notify() now skips the SMS attempt
-- outright for these types regardless of that preference, the same way
-- auto_send_enabled already gates both channels together. Default 1
-- (on) for every existing/future type, so this is additive everywhere
-- except the 9 rows explicitly flipped off below - floater_assignment
-- (the whole point of that feature is the text itself), event_cancelled,
-- membership_approved/denied, text_message, and email_campaign all keep
-- their current SMS behavior unchanged.
alter table notification_types add column if not exists sms_enabled integer not null default 1;

update notification_types set sms_enabled = 0 where key in (
  'class_waitlist_promoted',
  'event_waitlist_promoted',
  'class_registration',
  'event_registration',
  'event_submission_decided',
  'babysitter_submission_decided',
  'forum_reply',
  'announcement',
  'newsletter_sent'
);
