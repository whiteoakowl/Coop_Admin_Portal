-- A real request: "Full 7 day expansion so multiple semesters can be
-- created an managed... now day settings. So we can create multiple
-- semester schedule grids and all the floater and setup cleanup features
-- for each to go with it. Then this will work for years to come." Phase
-- 1 of that: a new class_schedules entity (the "Day Settings" an admin
-- creates) replaces the hardcoded Monday/Wednesday pair as the catalog of
-- which days currently have a Classes grid, each scoped to one semester
-- so a brand new semester can add a day (e.g. Tuesday Enrichment) without
-- disturbing any other semester's own grids. Volunteers/Setup-Cleanup/
-- Member Schedules/Name Tags/Rosters/Dashboard follow in later phases -
-- each has its own hardcoded-day-pair assumptions baked into templates
-- and CSV formats that need their own dedicated pass.
create table if not exists class_schedules (
  id integer generated always as identity primary key,
  title text not null,
  day_of_week text not null check (day_of_week in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday')),
  semester_id integer references semesters(id) on delete cascade,
  start_date text,
  end_date text,
  created_at text not null default now_text()
);
-- A plain unique constraint can't use an expression like coalesce() -
-- same NULL-collapsing trick as volunteer_lists' own semester migration
-- (20261024010000_kiosk_semester_scoping.sql), as an index instead.
create unique index if not exists idx_class_schedules_day_semester on class_schedules (day_of_week, coalesce(semester_id, -1));

-- classes.day and class_schedule_hours.day both only ever allowed
-- 'monday'/'wednesday' - widened to the full week so a class_schedules
-- row can actually be used. (Volunteers/Setup-Cleanup's own day columns,
-- widened in a later phase, are untouched here.)
alter table classes drop constraint if exists classes_day_check;
alter table classes add constraint classes_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

alter table class_schedule_hours drop constraint if exists class_schedule_hours_day_check;
alter table class_schedule_hours add constraint class_schedule_hours_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));

-- Monday/Wednesday are the co-op's always-available meeting days from day
-- one, independent of whether Semesters has ever been used - unlike every
-- other day, they must exist even on a brand new install with zero
-- semesters and zero classes (the "no semester" bucket, same NULL
-- semester_id every other not-yet-semester-tagged row in this app uses).
-- Without this, a fresh database would start with an EMPTY class_schedules
-- table and ?tab=monday/?tab=wednesday would have nothing to resolve to.
insert into class_schedules (title, day_of_week, semester_id) values ('Monday', 'monday', null)
  on conflict (day_of_week, coalesce(semester_id, -1)) do nothing;
insert into class_schedules (title, day_of_week, semester_id) values ('Wednesday', 'wednesday', null)
  on conflict (day_of_week, coalesce(semester_id, -1)) do nothing;

-- Backfill: one class_schedules row for every (day, semester) pair that
-- already has at least one real class, titled plainly after its weekday -
-- every existing Monday/Wednesday grid (across every semester that's
-- ever had classes) keeps working exactly as it does today, with nothing
-- to re-create by hand. A semester with classes but no semester_id set at
-- all (pre-dates the Semesters feature) is already covered by the
-- unconditional Monday/Wednesday seed just above.
insert into class_schedules (title, day_of_week, semester_id)
select initcap(c.day), c.day, c.semester_id
from (select distinct day, semester_id from classes where semester_id is not null) c
on conflict (day_of_week, coalesce(semester_id, -1)) do nothing;

-- Also seed Monday/Wednesday for the most-recently-created semester even
-- if it has no classes yet (e.g. a semester just created on the Semester
-- tab, about to have its own classes added) - mirrors every other
-- semester-scoped default this app seeds onto "whichever semester is
-- newest."
do $$
declare
  latest_semester_id integer;
begin
  select id into latest_semester_id from semesters order by id desc limit 1;
  if latest_semester_id is not null then
    insert into class_schedules (title, day_of_week, semester_id) values ('Monday', 'monday', latest_semester_id)
      on conflict (day_of_week, coalesce(semester_id, -1)) do nothing;
    insert into class_schedules (title, day_of_week, semester_id) values ('Wednesday', 'wednesday', latest_semester_id)
      on conflict (day_of_week, coalesce(semester_id, -1)) do nothing;
  end if;
end $$;
