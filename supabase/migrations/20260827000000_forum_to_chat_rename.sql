-- A real request: "Change forum to chat, everywhere!" - a display-text-
-- only rename (the Forum/discussion-board feature itself, its routes,
-- tables, and the notification_types.key 'forum_reply' all stay exactly
-- as they are - only what a member actually reads changes). Every view/
-- route string was updated directly; this is the one piece of display
-- text that already shipped as seeded data in an earlier migration
-- (20260825110000_notifications.sql) and so has to be updated in place
-- rather than edited retroactively.
update notification_types set label = 'Chat Reply', description = 'Someone replied to a thread you started.' where key = 'forum_reply';
