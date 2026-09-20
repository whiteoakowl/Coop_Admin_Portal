-- A real request: "cancel event... automatic email will be sent to
-- anyone registered for the event to let them know the event is
-- canceled." Registrants are notified through the same notify()
-- entry point every other feature uses (see 20260825110000_notifications.sql),
-- which requires the type to exist in this catalog first.
insert into notification_types (key, label, description) values
  ('event_cancelled', 'Event Cancelled', 'An event you were registered for was cancelled.')
on conflict (key) do nothing;
