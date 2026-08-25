-- Community & Commerce track (Track B), item 6: Forums. Categories ->
-- threads -> posts, plus optional private class forums (scope='class',
-- class_id set) visible only to that class's own teacher/assistants
-- (class_staff), enrolled students (class_enrollments), and those
-- students' parents (read-only reference to Track A's classes/
-- class_enrollments/class_staff tables - never altered here, per the
-- hard boundary). A general category (scope='general') is visible to
-- any signed-in portal account, any role - members-only overall, no
-- public browsing, same reasoning as Member Directory.

create table if not exists forum_categories (
  id integer generated always as identity primary key,
  name text not null,
  description text,
  scope text not null default 'general' check (scope in ('general', 'class')),
  class_id integer references classes(id) on delete cascade,
  position integer not null default 0,
  is_locked integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_forum_categories_class on forum_categories(class_id);

create table if not exists forum_threads (
  id integer generated always as identity primary key,
  category_id integer not null references forum_categories(id) on delete cascade,
  title text not null,
  member_id integer references members(id) on delete set null,
  account_id integer references member_accounts(id) on delete set null,
  is_pinned integer not null default 0,
  is_locked integer not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_forum_threads_category on forum_threads(category_id);

-- body_html is sanitized server-side (utils/sanitizeHtml.js) before ever
-- being stored - the rich-text toolbar (public/js/forum-editor.js) only
-- ever offers a handful of safe tags (headings/bold/italic/lists/links/
-- quotes) but the sanitizer is what actually enforces that, not client
-- trust.
create table if not exists forum_posts (
  id integer generated always as identity primary key,
  thread_id integer not null references forum_threads(id) on delete cascade,
  member_id integer references members(id) on delete set null,
  account_id integer references member_accounts(id) on delete set null,
  body_html text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at text not null default now_text(),
  updated_at text not null default now_text(),
  edited_at text
);
create index if not exists idx_forum_posts_thread on forum_posts(thread_id);

-- The audit trail Forums' own spec explicitly calls for. Track B's later
-- sitewide Audit Log (handoff item 13) can read from tables like this one
-- once it exists, rather than this being retrofitted after the fact.
create table if not exists forum_moderation_actions (
  id integer generated always as identity primary key,
  actor_account_id integer references member_accounts(id) on delete set null,
  action text not null check (action in ('edit', 'remove', 'restore', 'lock', 'unlock', 'pin', 'unpin', 'archive', 'unarchive', 'move')),
  target_type text not null check (target_type in ('thread', 'post')),
  target_id integer not null,
  detail text,
  created_at text not null default now_text()
);
create index if not exists idx_forum_moderation_actions_target on forum_moderation_actions(target_type, target_id);
