-- A real request: "resource links, add resource, show on choosing a
-- portal dropdown should be a clean checkbox dropdown. Checkboxes next
-- to each portal." Replaces the single nullable role_key column (one
-- role, or null meaning everyone) with a many-to-many table, same
-- empty-means-unrestricted convention as forum_category_sections.
create table if not exists resource_link_roles (
  resource_link_id integer not null references resource_links(id) on delete cascade,
  role_key text not null references roles(key) on delete cascade,
  primary key (resource_link_id, role_key)
);

insert into resource_link_roles (resource_link_id, role_key)
  select id, role_key from resource_links where role_key is not null
  on conflict do nothing;

alter table resource_links drop column if exists role_key;
