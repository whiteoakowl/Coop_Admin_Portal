-- A real request: class registration gets a real waitlist (position
-- number tracked, see 20260826020000_class_registration_rules.sql) - and
-- when someone ahead cancels, the next waitlisted student is promoted to
-- confirmed automatically (routes/parent-portal.js's own unregister
-- route). This is what that promotion notifies the registering account
-- through, same "insert into notification_types, on conflict do nothing"
-- pattern as 20260826000000_announcement_notification_type.sql.
insert into notification_types (key, label, description) values
  ('class_waitlist_promoted', 'Moved Off Waitlist', 'A waitlisted class registration was promoted to confirmed because a spot opened up.')
on conflict (key) do nothing;
