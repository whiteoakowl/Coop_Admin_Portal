-- A real request: "Co-op admin portal. Add an orientation tab. List of
-- members registered for classes on either day. Columns, member name,
-- day Monday/Wednesday, orientation video, orientation meet up, teacher
-- training and tour. The last four are circle check boxes that show
-- green when complete. When they check in for the tour, check in for
-- orientation meet up, complete the parent orientation video and teacher
-- orientation video. Percentage to complete at the end of the row.
-- Subpages, tour check in, orientation check in."
--
-- One row per (primary parent, day) pair - orientation/tour/teacher
-- training is a family-level obligation tied to whichever day(s) that
-- family has a student enrolled in classes, not a per-student one (two
-- siblings enrolled in the same day's classes share one row - see
-- utils/orientation.js's own comment on why it's keyed off the primary
-- parent, reusing the same primaryParentsFor lookup Schedule Cards
-- already use). member_id intentionally has no foreign key ON DELETE
-- CASCADE tie to a specific class or enrollment - this table outlives
-- any one term's roster, same as student_academic_history's own reasoning.
create table if not exists orientation_progress (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  day text not null check (day in ('monday', 'wednesday')),
  video_complete integer not null default 0,
  video_completed_at text,
  meetup_complete integer not null default 0,
  meetup_completed_at text,
  teacher_training_complete integer not null default 0,
  teacher_training_completed_at text,
  tour_complete integer not null default 0,
  tour_completed_at text,
  unique (member_id, day)
);
create index if not exists idx_orientation_progress_member on orientation_progress(member_id);
