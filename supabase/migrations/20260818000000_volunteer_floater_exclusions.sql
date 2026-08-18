-- Real bug report: "when deleting members off the floater lists the
-- member isn't removed." Root cause: routes/admin-volunteers.js's
-- remove-member route deletes the volunteer_members row, then calls
-- syncDayMemberRosters(day) to keep the day's Parent/Student rosters in
-- sync - but that same sync unconditionally re-runs
-- autoAssignFloatersForDay(day) first (utils/classSchedule.js), which
-- re-derives "should this family's primary parent float this hour" from
-- scratch (their family's drop-off/pickup window overlaps the hour, and
-- they have no class of their own that hour) and re-inserts them right
-- back in - on the SAME request as the removal. volunteer_members has no
-- way to tell "never added" from "explicitly removed" (unlike
-- roster_members' own source column - see setRosterMembership). This
-- table records exactly that: an explicit removal that must survive the
-- very next auto-assign sync. autoAssignFloatersForDay now skips any
-- (member, section) pair listed here; an explicit re-add (+Add Member/
-- import - see addMemberToSection) clears the matching row, since a
-- deliberate add always wins over a past removal.
create table if not exists volunteer_floater_exclusions (
  volunteer_list_id integer not null references volunteer_lists(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  section_id integer not null references volunteer_sections(id) on delete cascade,
  primary key (volunteer_list_id, member_id, section_id)
);
