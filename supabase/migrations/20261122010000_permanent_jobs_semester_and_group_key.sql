-- A real bug report: "Floaters being needed for spring semester are still
-- showing on fall semester... Make sure... floater assignments...
-- EVERYTHING are separated by semester." permanent_jobs (Floater
-- Assignments' own recurring/temporary "Positions") had no semester_id at
-- all - a "Front Desk" position created under Spring showed up, and
-- could be edited/deleted from, Fall's own Floater Assignments page too.
--
-- A second, related part of the same report: "If there are more than one
-- class with the same name it should still be separate in the system...
-- Each numbered setup/cleanup tasks should have its own id even if there
-- are more than one with the same name." utils/substitutes.js's own
-- groupedPermanentJobsForDay/savePositionGroup/deletePositionGroup
-- grouped a "position"'s several per-hour rows together by matching on
-- day+title TEXT alone - two genuinely separate positions that happen to
-- share a title (easy to do once the same title can now legitimately
-- exist in two different semesters) were silently treated as the SAME
-- position, merging their hours/room/floater list together. group_key is
-- a stable, opaque identifier (set to the group's own first-created
-- row's id, and copied onto every row added to that same group
-- afterward) that utils/substitutes.js now matches siblings by instead -
-- two same-named positions get two different group_key values and stay
-- fully separate regardless of title.
alter table permanent_jobs add column if not exists semester_id integer references semesters(id) on delete set null;
alter table permanent_jobs add column if not exists group_key integer;

-- Backfill: every existing row's group_key becomes the lowest id among
-- its own (day, title, session_date) group - exactly the grouping
-- groupedPermanentJobsForDay/groupedTemporaryJobsForDayDate already used
-- before this migration, so an admin's already-saved multi-hour
-- positions stay grouped exactly as they appear today. This is a one-
-- time snapshot of the OLD text-matched grouping, not an ongoing rule -
-- every new/edited position from here on gets a real group_key at
-- creation instead of being re-derived from its title.
update permanent_jobs pj
set group_key = sub.min_id
from (
  select day, title, session_date, min(id) as min_id
  from permanent_jobs
  group by day, title, session_date
) sub
where pj.day = sub.day
  and pj.title = sub.title
  and pj.session_date is not distinct from sub.session_date
  and pj.group_key is null;
