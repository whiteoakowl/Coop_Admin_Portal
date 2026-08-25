-- Community & Commerce track (Track B), item 5: Member Directory. No new
-- copy of member data - this reads live from the existing `members`/
-- `families` tables (Track A's own domain, read-only here) rather than
-- duplicating it. Two small settings tables control what's actually
-- shown: which FIELDS a Main Admin has turned on directory-wide (never
-- expose a field just because it exists on `members` - a deliberate
-- allowlist a Main Admin opts fields INTO, not an every-field toggle),
-- and which INDIVIDUAL members have opted themselves (or a family
-- member) out entirely. Members-only, no public option - this is real
-- personal contact information, unlike Events/Directory/Classifieds'
-- own public/members visibility toggle.

create table if not exists member_directory_field_settings (
  -- One of a fixed catalog utils/memberDirectory.js defines
  -- (DIRECTORY_FIELDS) - deliberately not free text, so a Main Admin can
  -- only ever turn on a field this app was actually built to display
  -- safely, never an arbitrary members column.
  field_key text primary key check (field_key in ('photo', 'phone', 'email', 'address', 'grade_level', 'family')),
  visible integer not null default 0,
  updated_at text not null default now_text()
);

create table if not exists member_directory_opt_outs (
  member_id integer primary key references members(id) on delete cascade,
  opted_out_at text not null default now_text()
);
