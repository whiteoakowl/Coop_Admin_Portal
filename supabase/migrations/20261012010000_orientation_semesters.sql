-- A real request: "Now each orientation semester is created with all
-- members registered for classes that semester." Orientation progress
-- moves from being tracked per (member, day) to per (member, semester) -
-- a family's orientation is tracked fresh for each semester (via the new
-- Semester concept - see 20261011010000_semesters.sql), and a family
-- registered for both Monday and Wednesday classes no longer gets two
-- separate rows/circle-sets: which day(s) a family attends is now purely
-- a display value computed live from class_enrollments (see utils/
-- orientation.js's own orientationRows), not something orientation
-- progress itself is keyed by.
alter table orientation_progress add column if not exists semester_id integer references semesters(id) on delete cascade;

alter table orientation_progress drop constraint if exists orientation_progress_member_id_day_key;

-- Merge any existing per-day rows for the same member (OR each _complete
-- flag together, keep the latest _completed_at of the two) before
-- dropping the day column entirely - a real bug this data migration
-- avoids: two Monday/Wednesday rows for the same family silently
-- collapsing to whichever one happens to survive, losing the other
-- day's already-recorded progress.
with merged as (
  select
    member_id,
    max(video_complete) as video_complete,
    max(video_completed_at) as video_completed_at,
    max(meetup_complete) as meetup_complete,
    max(meetup_completed_at) as meetup_completed_at,
    max(teacher_training_complete) as teacher_training_complete,
    max(teacher_training_completed_at) as teacher_training_completed_at,
    max(tour_complete) as tour_complete,
    max(tour_completed_at) as tour_completed_at,
    max(open_house_complete) as open_house_complete,
    max(open_house_completed_at) as open_house_completed_at,
    min(id) as keep_id
  from orientation_progress
  group by member_id
)
update orientation_progress op
set video_complete = merged.video_complete,
    video_completed_at = merged.video_completed_at,
    meetup_complete = merged.meetup_complete,
    meetup_completed_at = merged.meetup_completed_at,
    teacher_training_complete = merged.teacher_training_complete,
    teacher_training_completed_at = merged.teacher_training_completed_at,
    tour_complete = merged.tour_complete,
    tour_completed_at = merged.tour_completed_at,
    open_house_complete = merged.open_house_complete,
    open_house_completed_at = merged.open_house_completed_at
from merged
where op.id = merged.keep_id;

delete from orientation_progress
where id not in (select min(id) from orientation_progress group by member_id);

alter table orientation_progress drop column if exists day;

-- A plain unique constraint can't be used here since Postgres treats
-- every NULL semester_id as distinct from every other - the coalesce
-- collapses every "no semester" row into one shared bucket (the
-- fallback view when no semesters have been created yet), same trick
-- utils/orientation.js's own setOrientationField relies on for its
-- ON CONFLICT target.
create unique index if not exists idx_orientation_progress_member_semester on orientation_progress (member_id, coalesce(semester_id, -1));

-- A real request: "Add button for orientation settings to Link training
-- or check in with each circle check mark column so the information can
-- be linked" - one optional URL per checkmark column (video/meetup/
-- teacherTraining/tour/openHouse - see utils/orientation.js's own FIELDS),
-- so each column's header can link out to the actual training video or
-- check-in event instead of being purely a plain label.
create table if not exists orientation_settings (
  field text primary key,
  link_url text not null
);
