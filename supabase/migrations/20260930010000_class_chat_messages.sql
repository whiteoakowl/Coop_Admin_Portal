-- A real request: "classes tabs, add class chat" - a simple message log
-- scoped to one class, for Co-op Admin's own legacy admin session (a
-- follow-up question confirmed: a separate, simple board here rather
-- than reusing the existing Main Admin/portal forums feature, which
-- lives entirely under a different login this page's own admin session
-- doesn't carry). No threads/moderation/sections - just a flat,
-- chronological log, same "cascade-deleted with the class" convention
-- every other classes_id-owned table already uses.
create table if not exists class_chat_messages (
  id integer generated always as identity primary key,
  class_id integer not null references classes(id) on delete cascade,
  admin_username text not null,
  body text not null,
  created_at text not null default now_text()
);
create index if not exists idx_class_chat_messages_class on class_chat_messages(class_id, created_at);
