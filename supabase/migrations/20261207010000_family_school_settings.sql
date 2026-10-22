-- A real request: "Family school management settings subpage. Parent
-- can add school name, school logo and colors. NC homeschool ID
-- number. The school name, logo and colors will be used as the header
-- for all family school management pdf pages and printing pages." One
-- row per family (its own "school" identity for this family's own
-- homeschool records), not a second global app_settings-style row -
-- every other family's own print pages must stay branded with their
-- own name/logo/colors, never one family's.
create table if not exists family_school_settings (
  family_id integer primary key references families(id) on delete cascade,
  school_name text,
  logo_key text,
  color_primary text,
  color_secondary text,
  nc_homeschool_id text,
  updated_at text not null default now_text()
);
