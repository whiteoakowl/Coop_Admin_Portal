-- A real request: "main admin, chat tab, add chat room where people can
-- talk to each other in a live continuous feed." A chat room is a
-- forum_categories row with is_chat_room=1 - instead of members starting
-- their own titled threads (the normal Chat Group behavior), a chat room
-- eagerly gets exactly one underlying forum_threads row (room_thread_id)
-- whose posts ARE the live feed. Reuses forum_posts/forum_threads and
-- all their existing sanitization/moderation/notification plumbing
-- rather than a parallel messages table.
alter table forum_categories add column if not exists is_chat_room integer not null default 0;
alter table forum_categories add column if not exists room_thread_id integer references forum_threads(id) on delete set null;
