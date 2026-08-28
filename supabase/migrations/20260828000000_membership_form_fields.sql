-- A real request: "under members in main admin portal there should be a
-- settings tab for editing and adding parts of the membership form."
-- Admin-defined extra questions, shown after the fixed Name/Email/Phone
-- (parent) or Name/Birthday/Grade/Medical Notes (child) fields already
-- built into the Membership Form/Add Member forms (views/member-intake-
-- form.ejs) and the public self-registration application (views/portal-
-- register.ejs) - both share this same field set via utils/
-- membershipFormFields.js, so an admin only has to define a field once
-- for it to show up everywhere a family gets entered into the system.
--
-- `target` splits fields between the Parent/Guardian block and the
-- Student block, since those are two entirely separate repeatable
-- sections on both forms. `options` is a JSON array of strings, used
-- only when field_type = 'dropdown' (mirrors the "JSON blob for a
-- choice list" convention supabase/migrations/20260825070000_custom_forms.sql
-- already uses for its own field options).
create table if not exists membership_form_fields (
  id integer generated always as identity primary key,
  target text not null check (target in ('parent', 'child')),
  field_key text not null,
  label text not null,
  field_type text not null default 'short_text' check (field_type in ('short_text', 'long_text', 'dropdown', 'checkbox')),
  options text,
  is_required boolean not null default false,
  position integer not null default 0,
  created_at text not null default now_text()
);
create unique index if not exists idx_membership_form_fields_key on membership_form_fields(target, field_key);

-- One row per (field, member) - a parent's or child's answer to one
-- admin-defined question. member_id cascades on delete, same as every
-- other per-member detail table in this app (e.g. member_sections).
create table if not exists membership_form_field_values (
  id integer generated always as identity primary key,
  field_id integer not null references membership_form_fields(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  value text,
  unique (field_id, member_id)
);
create index if not exists idx_membership_form_field_values_member on membership_form_field_values(member_id);
