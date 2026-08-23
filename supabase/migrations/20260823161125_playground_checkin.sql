-- Real request: "we need to add a playground check in and out and log.
-- anybody can check in and out of the playground. it doesn't have a set
-- roster." Reuses the existing rosters/attendance/checkouts tables rather
-- than inventing a parallel log - one roster per (day, hour_position),
-- lazily created the same way a class's own roster is (see
-- ensureClassRoster in utils/classSchedule.js) - so every existing
-- attendance/checkouts index and constraint already covers this. The one
-- real difference from every other roster on this site: "who's on it" is
-- never a fixed roster_members list - it's simply whoever has an
-- attendance/checkouts row for that roster+date, since anybody can walk up
-- and check in with no enrollment step at all (see
-- utils/playground.js's playgroundLogForDate).
create table if not exists playground_rosters (
  day text not null check (day in ('monday','wednesday')),
  hour_position integer not null check (hour_position between 1 and 4),
  roster_id integer not null references rosters(id) on delete cascade,
  primary key (day, hour_position)
);
