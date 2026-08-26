-- A real request: Main Admin should be able to compose and send a
-- customized announcement to some or all members, and Parent Portal's
-- home page should show current + past announcements sent to that
-- account. Reuses the existing notification_types/notifications/
-- notification_deliveries tables (supabase/migrations/
-- 20260825110000_notifications.sql) rather than a parallel "announcement"
-- table - an announcement IS a notification, same as newsletter_sent/
-- event_registration/forum_reply already are, just triggered by a Main
-- Admin composing one instead of another feature's own automated event.
insert into notification_types (key, label, description) values
  ('announcement', 'Announcement', 'A message Main Admin sent to some or all members.')
on conflict (key) do nothing;
