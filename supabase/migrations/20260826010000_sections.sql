-- A real request: group members into named "sections" (e.g. "Teen Co-op",
-- "Homeschool Group A") independent of Family, so Events and Classes can
-- each optionally restrict who can see/register for them to specific
-- sections. A brand new, generic grouping concept - not reusing Family
-- (which already means something else: a household) or Roles (which
-- mean "which portal/permissions", not "which group of the co-op this
-- member belongs to").
create table if not exists sections (
  id integer generated always as identity primary key,
  name text not null unique,
  description text,
  created_at text not null default now_text()
);

create table if not exists member_sections (
  member_id integer not null references members(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (member_id, section_id)
);
create index if not exists idx_member_sections_section on member_sections(section_id);
