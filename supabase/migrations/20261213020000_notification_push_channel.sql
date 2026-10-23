-- A real request: "Parent portal/family school management portal,
-- settings gear, should have a notifications settings card to control
-- email, text and push notifications." No push-notification infrastructure
-- exists anywhere in this app yet (no service-worker subscriptions, no
-- VAPID keys, nothing to actually deliver one) - per the user's own
-- explicit choice, the preference toggle is added now anyway (saves
-- correctly, shows on the Notification Preferences page) so it's ready
-- the moment a real push channel is wired up later. notification_
-- preferences' own channel CHECK constraint only allowed ('email', 'sms')
-- - widening it to also accept 'push' is all this needs; notify() never
-- writes a notification_deliveries row for push today (there's nothing to
-- attempt), so that table's own CHECK constraint is untouched.
alter table notification_preferences drop constraint if exists notification_preferences_channel_check;
alter table notification_preferences add constraint notification_preferences_channel_check check (channel in ('email', 'sms', 'push'));
