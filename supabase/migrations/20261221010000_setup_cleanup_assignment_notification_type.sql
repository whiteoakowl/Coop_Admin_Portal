-- A real request: "Add the same exact check box and button system on
-- floater assignments, on each setup cleanup team and position." The
-- Setup/Cleanup Assignments page (routes/admin-setup.js, views/
-- partials/setup-assignment-cards.ejs) gets its own Select All checkbox
-- + Send Text button per team card, same as Floater Assignments' own
-- per-hour card (see 20261201010000_floater_assignment_notification_type.sql
-- and 20261217010000_notification_message_templates.sql for that
-- feature's own matching rows) - texts a member their team and
-- currently-assigned task(s) for the selected date.
insert into notification_types (key, label, description) values
  ('setup_cleanup_assignment', 'Setup/Cleanup Assignment', 'You were texted your Setup/Cleanup team and assigned task(s) for an upcoming co-op session.')
on conflict (key) do nothing;

insert into notification_message_templates (template_key, subject, body) values
  ('setup_cleanup_assignment_default', '', 'You''re assigned to {{team}}: {{tasks}}.')
on conflict (template_key) do nothing;
