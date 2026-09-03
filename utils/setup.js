const db = require('../db');
const { byLastName, hasInfantChild } = require('./members');
const { todayISO } = require('./dates');
const { taskSectionForTeam, refreshBadgesForTeam } = require('./taskList');
const { absentMemberIdsForDate, checkedInMemberIdsForDate } = require('./classSchedule');

async function teamsForDay(day) {
  return db
    .prepare(
      `SELECT st.*, m.name AS "leaderName"
       FROM setup_teams st
       LEFT JOIN members m ON m.id = st.leader_id AND m.active = 1
       WHERE st.day = ?
       ORDER BY LOWER(st.title)`
    )
    .all(day);
}

// Every Setup/Cleanup team with its member count - shared by both
// portals' own member Add/Edit form ("Setup Team - 2 members"
// checklist), pulled out here so routes/admin-members.js and
// routes/main-admin-members.js can't drift into two different queries
// for the same list.
async function allSetupTeams() {
  return db
    .prepare(
      `SELECT t.id, t.day, t.title, COUNT(stm.member_id) AS "memberCount"
       FROM setup_teams t
       LEFT JOIN setup_team_members stm ON stm.team_id = t.id
       GROUP BY t.id
       ORDER BY t.day, LOWER(t.title)`
    )
    .all();
}

async function cleanupTeamIdsForMember(memberId) {
  return (await db.prepare('SELECT team_id FROM setup_team_members WHERE member_id = ?').all(memberId)).map((r) => r.team_id);
}

async function membersForTeam(teamId) {
  const members = await db
    .prepare(
      `SELECT m.* FROM members m
       JOIN setup_team_members stm ON stm.member_id = m.id
       WHERE stm.team_id = ? AND m.active = 1`
    )
    .all(teamId);
  return members.sort(byLastName);
}

async function setTeamLeader(teamId, leaderId) {
  await db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(leaderId || null, teamId);
  // A real request: a Setup/Cleanup badge should always show its team's
  // CURRENT leader - without this, reassigning a leader here wouldn't
  // show up on any badge already printed-from until that one task
  // happened to be edited again.
  await refreshBadgesForTeam(teamId);
}

// The team card's Edit popup - title/description/leader/meeting time+
// location all saved together in one Save action (see routes/admin-
// setup.js), unlike the old inline auto-submitting leader select this
// replaced. A real request: "setup/cleanup team cards should have a
// space for time to meet and meeting location" - meetingTime/
// meetingLocation are free text (same shape as description), not a
// structured time/date picker - a team's own meeting time is usually
// just "before drop-off" or "9:00am" prose, not a value that needs to be
// compared or sorted anywhere.
async function updateTeam(teamId, fields) {
  await db.prepare('UPDATE setup_teams SET title = ?, description = ?, leader_id = ?, meeting_time = ?, meeting_location = ?, task_scan_timing = ? WHERE id = ?').run(
    fields.title,
    fields.description || null,
    fields.leaderId || null,
    fields.meetingTime || null,
    fields.meetingLocation || null,
    fields.taskScanTiming === 'checkin' ? 'checkin' : 'checkout',
    teamId
  );
  // Same badge-freshness reasoning as setTeamLeader above - a team rename
  // shouldn't leave stale badges behind either.
  await refreshBadgesForTeam(teamId);
}

// A real request: "if a member is a leader of a setup/cleanup team, they
// will not be asked for a setup/cleanup badge for scanning at check in or
// out. only members added to setup/cleanup teams will be asked for a
// setup/cleanup badge scan." Leading a team is a supervisory role, not a
// scan-a-badge-yourself task, so a leader is exempt from the scan step
// even on a day they're ALSO listed as a rank-and-file setup_team_members
// row on that same team.
async function isSetupTeamLeaderForDay(memberId, day) {
  const row = await db.prepare('SELECT 1 FROM setup_teams WHERE leader_id = ? AND day = ? LIMIT 1').get(memberId, day);
  return !!row;
}

// A real request: "add a dropdown menu to each setup/cleanup team list
// that asks, log on check in or log on check out. choosing one or the
// other will determine when a member is asked to scan their setup/
// cleanup card." Every parent/admin used to always be asked to scan
// their Setup/Cleanup badge at CHECK OUT (routes/checkout.js) with no
// team-level choice at all - true here means their own team (for that
// day) opted into asking at CHECK IN instead (routes/kiosk.js). Not on
// any team, or only on 'checkout' team(s), keeps that original always-
// ask-at-checkout behavior. A member on more than one team for the same
// day (unusual, but not disallowed) only needs ONE of them set to
// 'checkin' to be asked at check-in. A team leader is exempt - see
// isSetupTeamLeaderForDay above.
async function memberScansTaskAtCheckin(memberId, day) {
  if (await isSetupTeamLeaderForDay(memberId, day)) return false;
  const row = await db
    .prepare(
      `SELECT 1 FROM setup_team_members stm
       JOIN setup_teams st ON st.id = stm.team_id
       WHERE stm.member_id = ? AND st.day = ? AND st.task_scan_timing = 'checkin'
       LIMIT 1`
    )
    .get(memberId, day);
  return !!row;
}

// The CHECK OUT-side mirror of memberScansTaskAtCheckin above - a real
// bug report/request: "only members added to setup/cleanup teams will be
// asked for a setup/cleanup badge scan." routes/checkout.js used to ask
// EVERY parent/admin to scan a Setup/Cleanup badge at checkout with no
// team check at all (not even "are they on a team"), unlike the check-in
// side which already gated on setup_team_members. Same leader exemption,
// and only ever true for a team whose task_scan_timing is 'checkout' (the
// default) - a 'checkin' team member who somehow reaches checkout without
// having scanned yet is still handled by routes/checkout.js's own
// already-logged carryover, not asked again here.
async function memberNeedsSetupBadgeAtCheckout(memberId, day) {
  if (await isSetupTeamLeaderForDay(memberId, day)) return false;
  const row = await db
    .prepare(
      `SELECT 1 FROM setup_team_members stm
       JOIN setup_teams st ON st.id = stm.team_id
       WHERE stm.member_id = ? AND st.day = ? AND st.task_scan_timing = 'checkout'
       LIMIT 1`
    )
    .get(memberId, day);
  return !!row;
}

// --- Setup/Cleanup Assignments (date-scoped, unlike the standing team
// roster above) - mirrors utils/volunteers.js's datesForList/
// membersForList/assignments shape, just keyed by `day` directly since
// setup_teams has no single "list" a date belongs to. ---

async function datesForDay(day) {
  return (await db.prepare('SELECT session_date FROM setup_dates WHERE day = ? ORDER BY session_date ASC').all(day)).map((r) => r.session_date);
}

async function addSetupDates(day, dates) {
  const insertDate = db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?) ON CONFLICT (day, session_date) DO NOTHING');
  for (const d of dates) await insertDate.run(day, d);
}

async function removeSetupDate(day, date) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM setup_dates WHERE day = ? AND session_date = ?').run(day, date);
    await tx.prepare('DELETE FROM setup_task_assignments WHERE day = ? AND session_date = ?').run(day, date);
  });
}

// { [memberId]: { taskItemId, taskItemId2 } } for one date - only members
// with at least one real suggestion set show up as keys, same "absent
// means not in the map" shape as familyAttendanceWindowsForDay elsewhere
// in this app; either slot on a present member can still individually be
// null (one job suggested, not two).
async function taskAssignmentsForDate(day, date) {
  const rows = await db
    .prepare(
      `SELECT member_id AS "memberId", task_item_id AS "taskItemId", task_item_id_2 AS "taskItemId2"
       FROM setup_task_assignments WHERE day = ? AND session_date = ?`
    )
    .all(day, date);
  const byMember = {};
  rows.forEach((r) => {
    if (r.taskItemId != null || r.taskItemId2 != null) byMember[r.memberId] = { taskItemId: r.taskItemId, taskItemId2: r.taskItemId2 };
  });
  return byMember;
}

// slot 1 or 2 - a real bug report: a small team routinely needs one
// member covering two jobs, but the Assignments page only ever offered a
// single "Suggested Task" dropdown per member. Each slot is its own
// column (task_item_id / task_item_id_2) rather than a list, matching the
// page's own fixed "always exactly two dropdowns" shape (see
// partials/setup-assignment-cards.ejs). The suggestion dropdown
// auto-submits on change (same onchange="this.form.requestSubmit()"
// pattern as a Floater Teams rank select) - clearing ONE slot back to "no
// suggestion" (taskItemId falsy) only nulls that column, not the whole
// row, so the other slot's own suggestion survives; the row itself is
// only deleted once BOTH slots are empty, keeping
// taskAssignmentsForDate's "only real suggestions are keys" contract
// without a separate all-null check there.
async function setTaskAssignment(day, memberId, date, slot, taskItemId) {
  const column = slot === 2 ? 'task_item_id_2' : 'task_item_id';
  const otherColumn = slot === 2 ? 'task_item_id' : 'task_item_id_2';
  if (!taskItemId) {
    const existing = await db
      .prepare(`SELECT ${otherColumn} AS "other" FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?`)
      .get(day, memberId, date);
    if (existing && existing.other != null) {
      await db.prepare(`UPDATE setup_task_assignments SET ${column} = NULL WHERE day = ? AND member_id = ? AND session_date = ?`).run(day, memberId, date);
    } else {
      await db.prepare('DELETE FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').run(day, memberId, date);
    }
    return;
  }
  // Reject a task already held by a DIFFERENT member for this day/date -
  // taskOptionsExcludingAssignedElsewhere below already filters these out
  // of the suggestion dropdown, but that's a render-time filter only; a
  // second admin tab, a stale page, or two admins acting at once could
  // otherwise still write the same task to two members with nothing here
  // to stop it, defeating the whole reason this filtering exists (two
  // people showing up expecting to do the identical job).
  const conflict = await db
    .prepare(
      `SELECT member_id FROM setup_task_assignments
       WHERE day = ? AND session_date = ? AND member_id != ? AND (task_item_id = ? OR task_item_id_2 = ?)
       LIMIT 1`
    )
    .get(day, date, memberId, taskItemId, taskItemId);
  if (conflict) {
    throw new Error('That task has already been assigned to someone else for this date.');
  }

  await db
    .prepare(
      `INSERT INTO setup_task_assignments (day, member_id, session_date, ${column}) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, member_id, session_date) DO UPDATE SET ${column} = excluded.${column}`
    )
    .run(day, memberId, date, taskItemId);
}

// Splits a day's dates into "today or later" (what the Assignments page's
// own date dropdown offers - there's no reason to suggest a task for a
// date that's already passed) and "before today" (what the Archive tab
// lists) - same today-boundary split as Floater Assignments' own
// archive/manage routes.
function splitDatesByToday(dates) {
  const today = todayISO();
  return { upcoming: dates.filter((d) => d >= today), past: dates.filter((d) => d < today) };
}

// Each team's own linked task list (if any - see task_list_sections.team_id)
// rides along so its numbered tasks can print right on that team's card
// (item 31).
async function teamsWithMembers(day) {
  const teams = await teamsForDay(day);
  const result = [];
  for (const t of teams) {
    const members = await membersForTeam(t.id);
    // Same "(infant)" flag Floater Teams/Assignments already show next to
    // a parent's name (routes/admin-volunteers.js's own hasInfantChild
    // usage) - a real request to extend it to Setup/Cleanup's own team
    // list and assignment cards too, so a team lead knows at a glance
    // who might need different coverage.
    for (const m of members) m.infant = await hasInfantChild(m.id);
    result.push({ ...t, members, taskSection: await taskSectionForTeam(t.id) });
  }
  return result;
}

// A real request: once a task's been picked for one member, it shouldn't
// still show up as a pickable option for anyone else on the same team
// that same date - two people showing up expecting to do the identical
// job is exactly the kind of double-booking this suggestion list is
// meant to prevent. Tasks only ever mean anything within their own
// team's own linked list (see utils/taskList.js's taskSectionForTeam), so
// "someone else" means someone else on THIS team, not site-wide. Returns
// { [memberId]: { slot1Options, slot2Options } } - each member's own
// current slot1/slot2 value is always kept available in ITS OWN
// dropdown (so a saved value still shows what it is), even though that
// same value is excluded from every other member's dropdowns; a
// member's own two slots also can't both point at the same task, so
// each slot additionally excludes whatever the OTHER slot on that same
// member currently holds.
function taskOptionsExcludingAssignedElsewhere(allOptions, members) {
  const byMember = {};
  for (const m of members) {
    const takenByOthers = new Set();
    for (const other of members) {
      if (other.id === m.id) continue;
      if (other.taskItemId) takenByOthers.add(other.taskItemId);
      if (other.taskItemId2) takenByOthers.add(other.taskItemId2);
    }
    byMember[m.id] = {
      slot1Options: allOptions.filter((item) => !takenByOthers.has(item.id) && item.id !== m.taskItemId2),
      slot2Options: allOptions.filter((item) => !takenByOthers.has(item.id) && item.id !== m.taskItemId),
    };
  }
  return byMember;
}

// Defaults a DIFFERENT task per member's dropdown instead of every still-
// unassigned member's <select> silently defaulting to the same first
// option in the list (a real request: "each drop down menu next to
// members should suggest a different task from the list until there
// aren't any left"). Walks members in team order, handing out the next
// not-yet-suggested task from allOptions (wrapping back to the start once
// every distinct task has been suggested once, rather than leaving later
// members with nothing) - skipping anyone already assigned in this slot
// (nothing to suggest, they're locked) or absent (see the caller: "no
// tasks should be suggested for that member"). Only ever picks from that
// member's OWN options list (optionsKey) so a member-specific exclusion -
// their other slot's own value - is still respected. Returns
// { [memberId]: taskItemId }.
function suggestDistinctTasks(members, allOptions, assignedKey, optionsKey) {
  const suggestions = {};
  const n = allOptions.length;
  if (n === 0) return suggestions;
  let pointer = 0;
  for (const m of members) {
    if (m.absent || m[assignedKey]) continue;
    const options = m[optionsKey] || [];
    if (options.length === 0) continue;
    for (let i = 0; i < n; i++) {
      const candidate = allOptions[(pointer + i) % n];
      if (options.some((o) => o.id === candidate.id)) {
        suggestions[m.id] = candidate.id;
        pointer = (pointer + i + 1) % n;
        break;
      }
    }
  }
  return suggestions;
}

// One card per team for a given date - each member's currently-suggested
// task (if any) plus the list of tasks their team's own linked task list
// offers, i.e. what the suggestion dropdown's own options are. Shared by
// the live Assignments page (editable), the read-only Archive view/print/
// export for a past date, and the public/kiosk read-only view for today
// or the closest upcoming date (routes/setup.js) - same data, just
// rendered differently (see partials/setup-assignment-cards.ejs's own
// `editable` flag).
async function assignmentCardsForDate(day, date) {
  const teams = await teamsWithMembers(day);
  const assignments = date ? await taskAssignmentsForDate(day, date) : {};
  const absentIds = await absentMemberIdsForDate(date);
  // A real request: "highlight the member row red if they check in that
  // day" - lets the Assignments roster flag at a glance who's actually
  // on-site to do their task, same "compute on read from the attendance
  // table" shape as absentIds just above.
  const checkedInIds = await checkedInMemberIdsForDate(date);
  return teams.map((t) => {
    const allOptions = t.taskSection ? t.taskSection.items : [];
    const members = t.members.map((m) => {
      const a = assignments[m.id] || {};
      const taskItem = a.taskItemId && t.taskSection ? t.taskSection.items.find((i) => i.id === a.taskItemId) : null;
      const taskItem2 = a.taskItemId2 && t.taskSection ? t.taskSection.items.find((i) => i.id === a.taskItemId2) : null;
      return {
        id: m.id,
        name: m.name,
        infant: !!m.infant,
        absent: absentIds.has(m.id),
        checkedIn: checkedInIds.has(m.id),
        taskItemId: a.taskItemId || null,
        taskItemId2: a.taskItemId2 || null,
        taskNumber: taskItem ? taskItem.number : null,
        taskNumber2: taskItem2 ? taskItem2.number : null,
        taskDescription: taskItem ? taskItem.description : null,
        taskDescription2: taskItem2 ? taskItem2.description : null,
      };
    });
    const availableOptionsByMember = taskOptionsExcludingAssignedElsewhere(allOptions, members);
    const membersWithOptions = members.map((m) => ({ ...m, ...availableOptionsByMember[m.id] }));
    // Every Task 1 dropdown gets its own distinct suggestion before Task 2
    // dropdowns get theirs - a real request: "filling all the task one
    // dropdowns first then filling task 2 if out of spots."
    const slot1Suggestions = suggestDistinctTasks(membersWithOptions, allOptions, 'taskItemId', 'slot1Options');
    const slot2Suggestions = suggestDistinctTasks(membersWithOptions, allOptions, 'taskItemId2', 'slot2Options');
    // A real request: the card should also list, at its own bottom, every
    // task from this team's linked list that no one currently holds in
    // EITHER slot - actual assignments only, a suggested-but-not-yet-
    // clicked-Assign task still counts as unassigned. Recomputed fresh
    // from current assignments every render, so a task simply disappears
    // from this list the moment someone is assigned it, with nothing
    // further to track.
    const assignedTaskIds = new Set();
    for (const m of members) {
      if (m.taskItemId) assignedTaskIds.add(m.taskItemId);
      if (m.taskItemId2) assignedTaskIds.add(m.taskItemId2);
    }
    const unassignedTasks = allOptions.filter((item) => !assignedTaskIds.has(item.id));
    return {
      id: t.id,
      title: t.title,
      // A real request: "the leader, time, location, all those details
      // should show on the kiosk side when you click the setup/cleanup
      // button" - t already carries these (teamsForDay's own leaderName
      // join, plus setup_teams.meeting_time/meeting_location), just
      // hadn't been passed through this card shape before.
      leaderName: t.leaderName || null,
      meetingTime: t.meeting_time || null,
      meetingLocation: t.meeting_location || null,
      taskOptions: allOptions,
      unassignedTasks,
      members: membersWithOptions.map((m) => ({
        ...m,
        suggestedTaskItemId: slot1Suggestions[m.id] || null,
        suggestedTaskItemId2: slot2Suggestions[m.id] || null,
      })),
    };
  });
}

module.exports = {
  teamsForDay,
  allSetupTeams,
  cleanupTeamIdsForMember,
  membersForTeam,
  setTeamLeader,
  updateTeam,
  isSetupTeamLeaderForDay,
  memberScansTaskAtCheckin,
  memberNeedsSetupBadgeAtCheckout,
  datesForDay,
  addSetupDates,
  removeSetupDate,
  taskAssignmentsForDate,
  setTaskAssignment,
  splitDatesByToday,
  teamsWithMembers,
  assignmentCardsForDate,
};
