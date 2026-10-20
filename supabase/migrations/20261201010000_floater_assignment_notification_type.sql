-- Floater Assignments - "Text Notification" button (Co-op Admin >
-- Floater Assignments). A real request: select one or more filled
-- floater slots and text each assigned person their position, hour,
-- and room. Routes through notify() like every other feature in this
-- app (utils/notifications.js's own header comment: "notify() is the
-- single entry point every other feature calls"), so a member's SMS
-- opt-out/notification preferences are respected the same way any
-- other notification type's are, rather than a raw smsProvider.send()
-- bypass.
insert into notification_types (key, label, description) values
  ('floater_assignment', 'Floater Assignment', 'You were texted a floater position assignment (position, hour, and room) for an upcoming co-op session.')
on conflict (key) do nothing;
