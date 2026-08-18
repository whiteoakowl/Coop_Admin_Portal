-- Real request: an "admin name tag" (logo, name, barcode, ID number, admin
-- position) for co-op staff/leaders, plus a Settings-managed list of
-- position titles (e.g. "President", "Treasurer") that a member of type
-- 'admin' can optionally be assigned on the member form. members.member_type
-- and name_tag_templates.member_type's own CHECK constraints already allow
-- 'admin' (see the initial schema migration's own comment on both) - this
-- was reserved for exactly this feature, so neither needs widening here.
--
-- admin_positions is a flat ordered list, the same "Settings page manages a
-- list, other forms pick from it" shape as leadership_contacts/
-- task_list_items - just simpler (no sections, no per-row extra fields).
create table if not exists admin_positions (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

-- Optional - a member of any type could hold a listed position (typically
-- 'admin', but nothing here forces that), same nullable-FK "not chosen yet"
-- shape as members.family_id above. ON DELETE SET NULL so deleting a
-- position off the Settings list doesn't cascade-delete the members who
-- held it - it just clears their selection back to "none".
alter table members add column if not exists admin_position_id integer references admin_positions(id) on delete set null;
