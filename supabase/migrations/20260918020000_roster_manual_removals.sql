-- Real bug report: "Monday/Wednesday attendance. If someone is manually
-- deleted from the roster they are not automatically added back unless
-- their schedule changes." Before this, POST /admin/rosters/:tab/remove-
-- member/:memberId (routes/admin-rosters.js) just deleted the
-- roster_members row outright, with nothing remembering that removal was
-- deliberate - the next syncDayMemberRosters() run (triggered by ANY
-- other class's enrollment/staffing change that same day, not just this
-- member's own) recomputed the day's expected membership from scratch and
-- silently re-added them, since they were often still enrolled/staffed
-- exactly as before. This table is that memory: a row here means "an
-- admin explicitly removed this member from this roster - don't let a
-- routine resync put them back," cleared only when utils/classSchedule.js's
-- setEnrollment/addStaff record a genuine schedule change for that same
-- member (see those functions' own updated comments).
create table if not exists roster_manual_removals (
  roster_id integer not null references rosters(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  removed_at text not null default now_text(),
  primary key (roster_id, member_id)
);
