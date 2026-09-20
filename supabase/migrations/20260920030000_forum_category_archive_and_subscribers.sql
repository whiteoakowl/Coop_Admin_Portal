-- A real request: "lock the chat group should be under edit, not on the
-- front of the chat group card. There should also be an archive
-- button." Reuses forum_threads' own 'active'/'archived' status
-- convention (this table's own sibling already has it, see
-- 20260825060000_forums.sql) instead of a new one-off boolean.
alter table forum_categories add column if not exists status text not null default 'active' check (status in ('active', 'archived'));

-- A real request: "edit chat group... should also show a full list of
-- all members... a column next to each name with checkboxes that is
-- called email notifications. Checking the boxes says they will receive
-- notifications." A row's presence is the "on" state - nobody is
-- subscribed by default, since no such per-chat-group list exists for
-- anyone to have opted into yet (the inverse of notification_preferences'
-- own "only store what deviates from a default-on baseline" shape - this
-- one's baseline is off).
create table if not exists forum_category_subscribers (
  id integer generated always as identity primary key,
  category_id integer not null references forum_categories(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  created_at text not null default now_text(),
  unique (category_id, member_id)
);
create index if not exists idx_forum_category_subscribers_category on forum_category_subscribers(category_id);
