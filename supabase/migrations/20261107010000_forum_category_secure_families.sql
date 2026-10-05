-- A real request: "another check box column for secure... If you only
-- want certain families to be able to access this category, check this
-- box AND select which families can access it below." A second, family-
-- scoped access restriction alongside the existing section-scoped one
-- (forum_category_sections) - a secure category with no families
-- selected lets no one in (an admin must actively opt families in),
-- same "explicit allow-list" shape forum_category_sections already has.
alter table forum_categories add column if not exists is_secure integer not null default 0;

create table if not exists forum_category_families (
  category_id integer not null references forum_categories(id) on delete cascade,
  family_id integer not null references families(id) on delete cascade,
  primary key (category_id, family_id)
);
