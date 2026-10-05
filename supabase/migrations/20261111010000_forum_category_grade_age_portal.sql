-- A real request: "chat room settings and chat group settings add
-- clean dropdown menu for controlling and selecting grade levels by
-- checkbox. Another for select by age level. And one for portal
-- control on where these chat rooms can show up." Same lock-flag +
-- comma-list shape utils/events.js's own lock_registration_to_grade/
-- age_group and lock_registration_to_age/age_group_restriction already
-- use for events.
alter table forum_categories add column if not exists lock_by_grade integer not null default 0;
alter table forum_categories add column if not exists grade_restriction text;
alter table forum_categories add column if not exists lock_by_age integer not null default 0;
alter table forum_categories add column if not exists age_restriction text;

-- "Portal control" - which portal roles can see this category at all,
-- same empty-means-everyone convention forum_category_sections/
-- forum_category_families already use.
create table if not exists forum_category_roles (
  category_id integer not null references forum_categories(id) on delete cascade,
  role_key text not null references roles(key) on delete cascade,
  primary key (category_id, role_key)
);
