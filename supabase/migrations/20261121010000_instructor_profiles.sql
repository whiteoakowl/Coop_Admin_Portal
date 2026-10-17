-- A real request: "Co-op admin portal... Teachers/Assistants... Subpage,
-- instructor profiles, list of members who are signed up as teachers with
-- check mark for enable/disable instructors profile. Click on each member
-- and you can edit their instructor profile. It asks email, phone number,
-- about me, experience/qualifications (check box for include this).
-- Teachers can edit their instructor profile on the teacher portal if
-- they are given permission to view that portal and if their profile has
-- been enabled." One row per member who's ever been touched by this
-- feature (enabled and/or had fields saved) - created on first write
-- (see utils/instructorProfiles.js), not pre-seeded for every member who
-- happens to be class_staff somewhere. enabled is the admin-only on/off
-- switch: it gates both this profile showing as "on" in the admin's own
-- Instructor Profiles list AND whether the member's own Teacher Portal
-- self-edit page is reachable at all (middleware-enforced there, not
-- just hidden UI - see routes/teacher-portal.js). qualifications_visible
-- is the "check box for include this" next to the Experience/
-- Qualifications field specifically (the one field in this form actually
-- worded as optional-to-share) - off by default so a freshly-created
-- profile doesn't default to sharing it before anyone's opted in.
create table if not exists instructor_profiles (
  member_id integer primary key references members(id) on delete cascade,
  enabled integer not null default 0,
  email text,
  phone text,
  about_me text,
  qualifications text,
  qualifications_visible integer not null default 0,
  updated_at text not null default now_text()
);
