-- Two real follow-up requests on the Weekly Planner v2 (family_school_
-- weeks/_week_dates/_week_assignments, 20261203010000_weekly_planner_v2.sql):
--
-- 1. "Add two buttons add class assignment and add new assignment...
--    When clicking the add new assignment button you can add a fresh
--    and new assignment and it will ask title, description, link,
--    upload, grade, subject." The existing dialog already covered
--    subject/title (and an optional content_item_id pick) - description/
--    link_url/file_key/file_name/grade are new, only ever populated by
--    the "Add New Assignment" dialog (a content_item_id-backed "Add
--    Class Assignment" entry leaves them all null).
--
-- 2. "Weekly planner, check boxes next to each assignment. Check box on
--    each day for teacher to confirm the day is complete." completed
--    on family_school_week_assignments is the per-assignment checkbox;
--    completed on family_school_week_dates is the per-day one - two
--    independent booleans (checking every assignment in a day does NOT
--    auto-check the day, and vice versa isn't enforced either, since
--    "confirm the day is complete" reads as the parent/home-instructor's
--    own separate sign-off, not a computed roll-up).
alter table family_school_week_assignments add column if not exists description text;
alter table family_school_week_assignments add column if not exists link_url text;
alter table family_school_week_assignments add column if not exists file_key text;
alter table family_school_week_assignments add column if not exists file_name text;
alter table family_school_week_assignments add column if not exists grade text;
alter table family_school_week_assignments add column if not exists completed boolean not null default false;

alter table family_school_week_dates add column if not exists completed boolean not null default false;
