const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAY_LABELS, defaultDay, requireDay, parseDayValue } = require('../utils/days');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const {
  teamsForDay,
  setTeamLeader,
  updateTeam,
  datesForDay,
  addSetupDates,
  removeSetupDate,
  setTaskAssignment,
  splitDatesByToday,
  teamsWithMembers,
  assignmentCardsForDate,
} = require('../utils/setup');
const {
  taskListSectionsForDay,
  getSection,
  createSection,
  updateSection,
  deleteSection,
  swapSectionPosition,
  reorderSections,
  addItem,
  updateItem,
  deleteItem,
  swapItemPosition,
  reorderItems,
} = require('../utils/taskList');
const { toCsvRow, sendCsv, readRowsFromFile, buildTemplateWorkbook } = require('../utils/spreadsheet');
const { activeParentAndAdminOptions } = require('../utils/members');
const { spreadsheetFileFilter } = require('../utils/uploads');
const { getActiveKioskSemesterId } = require('../utils/kioskSettings');

const uploadTasks = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

// Lands on Assignments first, same as Floater Assignments' own /volunteers
// redirect - Assignments is the first of the 4 Setup/Cleanup tabs now
// (see partials/setup-tabs.ejs), not Teams.
router.get('/setup', requireAdmin, (req, res) => res.redirect(`/admin/setup/${defaultDay()}/assignments`));

// --- Manage page: create/edit/delete teams, add/remove members per team ---

router.get('/setup/:day/manage', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;

  res.render('admin-setup', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    day,
    dayLabel: DAY_LABELS[day],
    teams: await teamsWithMembers(day),
    // availableParents: the Add Member dialog's member picker. Used to be
    // parent-only by design, but a broader follow-up request widened
    // that: "admins should still be included in lists of members/parents
    // etc. for selecting ANYTHING across the site" - admins are regularly
    // hands-on team members too, not just leaders.
    availableParents: await activeParentAndAdminOptions(),
    // availableLeaders: the standing team card's own leader dropdown and
    // the Create New Team dialog's leader dropdown - a real request:
    // "for choosing a leader for setup/cleanup [team]s" should offer
    // admins alongside parents, since admins regularly run a team
    // themselves (see activeParentAndAdminOptions' own comment for why
    // this is a separate function from the parent-only activeParentOptions
    // the public Absence/Late and Name Tag Request forms still use).
    availableLeaders: await activeParentAndAdminOptions(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real bug report: "floater team and setup cleanup teams should have a
// print preview before going to print." The manage page's own Print
// button used to call window.print() directly on itself, jumping straight
// to the OS print dialog with no review step - every other print button
// site-wide instead lands on a dedicated read-only preview page first
// (see admin-setup-tasks-print.ejs) that the admin actually looks at
// before clicking ITS OWN Print button. This route/view gives Setup/
// Cleanup Teams the same pattern, reusing the exact same print-only CSS
// classes (team-print-page-fit, team-print-meta, setup-team-card-grid)
// the manage page's own @media print rules already relied on, so the
// preview is guaranteed to look exactly like the real printout - same
// markup, same shrink-to-fit script, just without any of the manage
// page's editable form controls that a read-only preview has no business
// showing.
router.get('/setup/:day/teams/print', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  res.render('admin-setup-teams-print', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    day,
    dayLabel: DAY_LABELS[day],
    teams: await teamsWithMembers(day),
  });
});

router.post('/setup/:day/teams', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  // A real request: "setup/cleanup team cards should have a space for
  // time to meet and meeting location."
  const meetingTime = (req.body.meetingTime || '').trim();
  const meetingLocation = (req.body.meetingLocation || '').trim();
  // A real request: "add a dropdown menu to each setup/cleanup team list
  // that asks, log on check in or log on check out." Defaults to
  // 'checkout' (today's original behavior) for anything else submitted.
  const taskScanTiming = req.body.taskScanTiming === 'checkin' ? 'checkin' : 'checkout';
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  await db
    .prepare('INSERT INTO setup_teams (day, title, description, leader_id, meeting_time, meeting_location, task_scan_timing, semester_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(day, title, description || null, leaderId, meetingTime || null, meetingLocation || null, taskScanTiming, await getActiveKioskSemesterId());
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent(`Team "${title}" created.`));
});

// Leader dropdown auto-submits on change, same pattern as a Floater
// Teams rank select - no separate "edit" step.
router.post('/setup/:day/teams/:teamId/leader', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  await setTeamLeader(teamId, leaderId);
  res.redirect(`/admin/setup/${day}/manage`);
});

// Team cards are view-only until Edit is clicked - title/description/
// leader/meeting time+location all save together from that one popup,
// replacing the old inline-editable card.
router.post('/setup/:day/teams/:teamId/edit', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  const meetingTime = (req.body.meetingTime || '').trim();
  const meetingLocation = (req.body.meetingLocation || '').trim();
  const taskScanTiming = req.body.taskScanTiming === 'checkin' ? 'checkin' : 'checkout';
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  await updateTeam(teamId, { title, description, leaderId, meetingTime, meetingLocation, taskScanTiming });

  // Member removal is its own immediate action now (the trash icon posts
  // straight to /remove-member/:memberId below via fetch - see "A real
  // request" comment there), not something that rides along with this
  // Save submission.
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent(`"${title}" updated.`));
});

router.post('/setup/:day/teams/:teamId/delete', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  await db.prepare('DELETE FROM setup_teams WHERE id = ? AND day = ?').run(teamId, day);
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent('Team deleted.'));
});

// Single "+ Add Member" popup (toolbar, not per-card) - member + team
// dropdowns, so adding someone doesn't require opening a specific card.
router.post('/setup/:day/teams/add-member', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.body.teamId, 10);
  const memberId = parseInt(req.body.memberId, 10);
  if (teamId && memberId) {
    await db
      .prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?) ON CONFLICT (team_id, member_id) DO NOTHING')
      .run(teamId, memberId);
  }
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent('Member added.'));
});

// A real request: "if you click the trash button the member name should
// automatically go away without having to save the team or refreshing
// the page" - replaces the old staged-until-Save removal (hidden
// checkbox + removeMemberIds on the /edit route above, which the Floater
// Teams card still uses unchanged - see team-member-remove-toggle.js's
// own per-row opt-in). public/js/team-member-instant-remove.js fetches
// this directly and removes the row from the DOM on success; a plain
// (non-fetch) request still gets the original redirect for safety.
router.post('/setup/:day/teams/:teamId/remove-member/:memberId', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  await db.prepare('DELETE FROM setup_team_members WHERE team_id = ? AND member_id = ?').run(teamId, memberId);
  if (wantsJson) return res.json({ ok: true });
  res.redirect(`/admin/setup/${day}/manage`);
});

router.get('/setup/:day/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teams = await teamsWithMembers(day);

  const lines = [toCsvRow(['Team', 'Description', 'Member'])];
  for (const t of teams) {
    if (t.members.length === 0) {
      lines.push(toCsvRow([t.title, t.description || '', '']));
    } else {
      for (const m of t.members) lines.push(toCsvRow([t.title, t.description || '', m.name]));
    }
  }

  sendCsv(res, `${day}-setup-cleanup-teams.csv`, lines);
});

// --- Assignments tab: date-scoped, unlike the standing Teams roster
// above - an admin picks a session date and suggests which task (from
// that team's own linked task list) each member should do that day.
// Mirrors Floater Assignments' manage/dates/archive shape (see
// routes/admin-volunteers.js), just simpler - no hours/positions/rooms,
// one flat per-member suggestion instead. ---

router.get('/setup/:day/assignments', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const dates = await datesForDay(day);
  const { upcoming } = splitDatesByToday(dates);
  const selectedDate = upcoming.includes(req.query.date) ? req.query.date : upcoming[0] || null;

  res.render('admin-setup-assignments', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Assignments`,
    day,
    dayLabel: DAY_LABELS[day],
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    upcomingDates: upcoming.map((d) => ({ date: d, label: formatDateLabel(d) })),
    selectedDate,
    cards: selectedDate ? await assignmentCardsForDate(day, selectedDate) : [],
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: "when adding dates to setup/cleanup it should stay on
// the pop up and simply immediately update the list with the new date
// and allow you to continue adding dates while window is still open.
// same if clicking remove a date, the date should disappear and pop up
// stay open for further editing and adding." Both routes now render the
// dialog's own date list back as HTML (see setup-dates-fragment.ejs) for
// a fetch caller (public/js/setup-dates.js) instead of redirecting - a
// plain, non-fetch form submit (JS disabled, or any other caller) still
// gets the original redirect, same isFetch split routes/admin-substitutes.js
// already established for the Floater Assignments board.
function isFetch(req) {
  return req.get('X-Requested-With') === 'fetch';
}

async function renderDatesFragment(req, res, day) {
  const dates = (await datesForDay(day)).map((d) => ({ date: d, label: formatDateLabel(d) }));
  res.render('setup-dates-fragment', { day, dates });
}

router.post('/setup/:day/dates/add', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  await addSetupDates(day, dates);
  if (isFetch(req)) return renderDatesFragment(req, res, day);
  res.redirect(`/admin/setup/${day}/assignments?notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/setup/:day/dates/:date/remove', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  await removeSetupDate(day, date);
  if (isFetch(req)) return renderDatesFragment(req, res, day);
  res.redirect(`/admin/setup/${day}/assignments?notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)}.`));
});

// A real request: Setup/Cleanup should "look and work like Floater
// Assignments" - a suggested-task dropdown next to an Assign button;
// clicking Assign locks the slot in place (plain text + an Unassign
// button takes the dropdown's place), clicking Unassign frees it back up
// for a different pick. Both directions post here (see partials/setup-
// assignment-cards.ejs) - Assign with a real taskItemId, Unassign with
// none - mirroring routes/admin-volunteers.js's own assign/unassign pair
// for the Floater Chart, just as one route instead of two since there's
// no separate "no one available" state to special-case here. Replaced
// the old whole-card Edit/Cancel/Save + batch-save-the-team flow this
// same route used to just feed on a plain onchange - that batching made
// sense for a many-field form-at-once save, but per-slot assign/unassign
// (like Floater's own per-row Accept/Unassign) is a closer match to how
// an admin actually works the page: one member, one job, right now.
//
// A real request: "do not refresh the page every time you assign or
// unassigned a setup/cleanup task. should be able to keep assigning all
// at once" - same isFetch JSON-vs-redirect split routes/admin-substitutes.js
// already established for the Floater Chart's own assign/unassign, so
// public/js/setup-assign.js can submit via fetch and re-fetch just the
// cards (see /assignments/fragment below) instead of a full page
// navigation; a plain, non-fetch form submit still gets the original
// redirect.
router.post('/setup/:day/assignments/:memberId/task', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const memberId = parseInt(req.params.memberId, 10);
  const date = req.body.date;
  const slot = req.body.slot === '2' ? 2 : 1;
  const taskItemId = parseInt(req.body.taskItemId, 10) || null;
  const back = `/admin/setup/${day}/assignments` + (date ? `?date=${encodeURIComponent(date)}` : '');
  if (date && isValidISODate(date)) {
    try {
      await setTaskAssignment(day, memberId, date, slot, taskItemId);
    } catch (e) {
      if (isFetch(req)) return res.status(400).json({ ok: false, error: e.message });
      return res.redirect(back + (date ? '&' : '?') + 'error=' + encodeURIComponent(e.message));
    }
  }
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect(back);
});

// public/js/setup-assign.js's own re-fetch target after a successful
// assign/unassign - recomputes every card for the current date rather
// than patching a single row, since one member's assignment can free up
// (or take) a task another member's own dropdown was suggesting - same
// reasoning as routes/admin-volunteers.js's own /fragment route for the
// Floater Chart.
router.get('/setup/:day/assignments/fragment', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const dates = await datesForDay(day);
  const { upcoming } = splitDatesByToday(dates);
  const selectedDate = upcoming.includes(req.query.date) ? req.query.date : upcoming[0] || null;
  const cards = selectedDate ? await assignmentCardsForDate(day, selectedDate) : [];
  res.render('setup-assignment-live-fragment', { day, dayLabel: DAY_LABELS[day], selectedDate, cards });
});

router.get('/setup/:day/assignments/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.query.date;
  const cards = date && isValidISODate(date) ? await assignmentCardsForDate(day, date) : [];

  const lines = [toCsvRow(['Team', 'Member', 'Suggested Task 1', 'Suggested Task 2'])];
  cards.forEach((t) => {
    if (t.members.length === 0) {
      lines.push(toCsvRow([t.title, '', '', '']));
    } else {
      t.members.forEach((m) => lines.push(toCsvRow([t.title, m.name, m.taskDescription || '', m.taskDescription2 || ''])));
    }
  });

  sendCsv(res, `${day}-setup-cleanup-assignments${date ? '-' + date : ''}.csv`, lines);
});

// --- Archive: read-only past dates, same "still-live, just filtered to
// dates before today" pattern as Floater Assignments' own archive (no
// snapshot-and-clear step - unlike the Attendance roster archive, there's
// nothing to clear since a past date's assignments were never in the way
// of a future one to begin with). ---

router.get('/setup/:day/archive', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const dates = await datesForDay(day);
  const { past } = splitDatesByToday(dates);
  const pastSorted = [...past].sort().reverse();
  const dateFilter = pastSorted.includes(req.query.date) ? req.query.date : null;

  res.render('admin-setup-archive', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Archive`,
    day,
    dayLabel: DAY_LABELS[day],
    dateOptions: pastSorted.map((d) => ({ date: d, label: formatDateLabel(d) })),
    dateFilter,
    rows: (dateFilter ? [dateFilter] : pastSorted).map((d) => ({ date: d, label: formatDateLabel(d) })),
  });
});

router.get('/setup/:day/archive/:date/view-fragment', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  const dates = await datesForDay(day);
  if (!dates.includes(date)) return res.status(404).send('Not found');

  res.render('setup-assignment-cards-fragment', {
    day,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: formatDateLabel(date),
    cards: await assignmentCardsForDate(day, date),
  });
});

router.get('/setup/:day/archive/:date/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  const dates = await datesForDay(day);
  if (!dates.includes(date)) return res.status(404).send('Not found');

  const cards = await assignmentCardsForDate(day, date);
  const lines = [toCsvRow(['Team', 'Member', 'Suggested Task 1', 'Suggested Task 2'])];
  cards.forEach((t) => {
    if (t.members.length === 0) {
      lines.push(toCsvRow([t.title, '', '', '']));
    } else {
      t.members.forEach((m) => lines.push(toCsvRow([t.title, m.name, m.taskDescription || '', m.taskDescription2 || ''])));
    }
  });
  sendCsv(res, `${day}-setup-cleanup-assignments-${date}.csv`, lines);
});

router.get('/setup/:day/archive/:date/print', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  const dates = await datesForDay(day);
  if (!dates.includes(date)) return res.status(404).send('Not found');

  res.render('admin-setup-archive-print', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Assignments — ${formatDateLabel(date)}`,
    day,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: formatDateLabel(date),
    cards: await assignmentCardsForDate(day, date),
  });
});

// --- Task List tab: stacked numbered task lists, optionally each tied
// to a Setup/Cleanup team (see utils/taskList.js taskSectionForTeam) ---

router.get('/setup/:day/tasks', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  res.render('admin-setup-tasks', {
    title: `${DAY_LABELS[day]} Task List`,
    day,
    dayLabel: DAY_LABELS[day],
    sections: await taskListSectionsForDay(day),
    teams: await teamsForDay(day),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/setup/:day/tasks/new', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const teamId = parseInt(req.body.teamId, 10) || null;
  if (!title) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('List title is required.'));
  }
  await createSection(day, title, teamId);
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent(`"${title}" created.`));
});

router.post('/setup/:day/tasks/:sectionId/delete', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  await deleteSection(parseInt(req.params.sectionId, 10));
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent('List deleted.'));
});

router.post('/setup/:day/tasks/:sectionId/move', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const sectionId = parseInt(req.params.sectionId, 10);
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  await swapSectionPosition(day, sectionId, direction);
  res.redirect(`/admin/setup/${day}/tasks`);
});

// Drag-and-drop reordering of the whole list stack - called via fetch
// from public/js/task-list-drag-reorder.js right after a drag ends
// (same pattern as public/js/room-row-reorder.js), not a full form
// submit. Doesn't replace the /move buttons above, just adds a faster
// way to do the same thing.
router.post('/setup/:day/tasks/reorder', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const sectionIds = [].concat(req.body.sectionIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  await reorderSections(day, sectionIds);
  res.json({ ok: true });
});

// Single "+ Add Task" popup (toolbar, not per-card) - description +
// which list dropdown, same pattern as Teams' "+ Add Member" popup.
router.post('/setup/:day/tasks/add-item', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const sectionId = parseInt(req.body.sectionId, 10);
  const description = (req.body.description || '').trim();
  if (!sectionId || !description) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('Choose a list and enter a task.'));
  }
  const section = await getSection(sectionId);
  if (!section || section.day !== day) return res.redirect(`/admin/setup/${day}/tasks`);
  await addItem(sectionId, description);
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent('Task added.'));
});

router.post('/setup/:day/tasks/:sectionId/items/:itemId/delete', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  await deleteItem(parseInt(req.params.itemId, 10));
  res.redirect(`/admin/setup/${day}/tasks`);
});

router.post('/setup/:day/tasks/:sectionId/items/:itemId/move', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const sectionId = parseInt(req.params.sectionId, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  await swapItemPosition(sectionId, itemId, direction);
  res.redirect(`/admin/setup/${day}/tasks`);
});

router.post('/setup/:day/tasks/:sectionId/items/reorder', requireAdmin, requireDay, async (req, res) => {
  const sectionId = parseInt(req.params.sectionId, 10);
  const itemIds = [].concat(req.body.itemIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  await reorderItems(sectionId, itemIds);
  res.json({ ok: true });
});

// Each list card's own checkmark Save button (a real request: "click
// edit button on each list... check mark is then at the top of the list
// card to save") posts here via fetch (public/js/task-list-edit.js) with
// just THAT card's own sectionTitle_/sectionTeam_/itemDesc_ fields - this
// loop only ever touches whichever keys it's actually given, so one
// card's save never needs to know or send anything about any other
// card's title/team/items. Reordering/deleting are their own immediate
// actions elsewhere, not part of this.
router.post('/setup/:day/tasks/save', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  for (const key of Object.keys(req.body)) {
    const sectionMatch = /^sectionTitle_(\d+)$/.exec(key);
    if (sectionMatch) {
      const id = parseInt(sectionMatch[1], 10);
      const section = await getSection(id);
      if (!section || section.day !== day) continue;
      const title = (req.body[key] || '').trim();
      const teamId = parseInt(req.body[`sectionTeam_${id}`], 10) || null;
      if (title) await updateSection(id, { title, teamId });
      continue;
    }
    const itemMatch = /^itemDesc_(\d+)$/.exec(key);
    if (itemMatch) {
      const id = parseInt(itemMatch[1], 10);
      const description = (req.body[key] || '').trim();
      if (description) await updateItem(id, description);
    }
  }
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent('Task list updated.'));
});

router.get('/setup/:day/tasks/import-template.xlsx', requireAdmin, requireDay, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['Number', 'Day', 'List', 'Task'],
    [
      ['1', 'Monday', 'Chairs & Tables', 'Set up 20 chairs in the main room'],
      ['2', 'Monday', 'Chairs & Tables', 'Fold and stack tables after use'],
      ['1', 'Wednesday', 'Kitchen', 'Wipe down counters and sink'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="task-list-import-template.xlsx"');
  res.send(buffer);
});

// Day tolerates "Mon"/"Wed" abbreviations, not just the full word (see
// utils/days.js's parseDayValue) - falls back to whichever day tab Import
// was clicked from when the column's blank, same convention the Class
// Schedule Import uses. Matches each row to an existing list by day + title
// (case-insensitive), creating the list (unlinked to any team) if it
// doesn't exist yet. Number controls only the ORDER rows land in their
// list - it's never itself stored, since a list's Number column is always
// just position (see itemsForSection); a row with no Number lands after
// every numbered row in that same list, in file order.
router.post('/setup/:day/tasks/import', requireAdmin, requireDay, uploadTasks.single('file'), async (req, res) => {
  const day = req.params.day;
  if (!req.file) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('Please choose a file to import.'));
  }
  let rawRows;
  try {
    rawRows = await readRowsFromFile(req.file.buffer);
  } catch (err) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  const rows = rawRows
    .map((row) => {
      const keys = Object.keys(row);
      const dayKey = keys.find((k) => k.trim().toLowerCase() === 'day');
      const listKey = keys.find((k) => k.trim().toLowerCase() === 'list');
      const taskKey = keys.find((k) => k.trim().toLowerCase() === 'task');
      const numberKey = keys.find((k) => k.trim().toLowerCase() === 'number');
      const rawDay = dayKey ? String(row[dayKey]).trim() : '';
      const number = numberKey ? parseInt(row[numberKey], 10) : NaN;
      return {
        day: rawDay ? parseDayValue(rawDay) : day,
        list: listKey ? String(row[listKey]).trim() : '',
        task: taskKey ? String(row[taskKey]).trim() : '',
        number: Number.isFinite(number) ? number : null,
      };
    })
    .filter((r) => r.day && r.list && r.task);

  // Grouped by day, then by list title (case-insensitive) - both to sort
  // each list's rows by Number before inserting, and so a list only
  // already-existing sections are looked up once per day instead of once
  // per row.
  const grouped = new Map(); // day -> Map(listTitleLower -> { listTitle, rows: [] })
  rows.forEach((r) => {
    if (!grouped.has(r.day)) grouped.set(r.day, new Map());
    const dayGroups = grouped.get(r.day);
    const key = r.list.toLowerCase();
    if (!dayGroups.has(key)) dayGroups.set(key, { listTitle: r.list, rows: [] });
    dayGroups.get(key).rows.push(r);
  });

  let added = 0;
  for (const [rowDay, dayGroups] of grouped) {
    const sectionIdByTitle = new Map();
    (await taskListSectionsForDay(rowDay)).forEach((s) => sectionIdByTitle.set(s.title.toLowerCase(), s.id));
    for (const [listKey, group] of dayGroups) {
      group.rows.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
      let sectionId = sectionIdByTitle.get(listKey);
      if (!sectionId) {
        sectionId = await createSection(rowDay, group.listTitle, null);
        sectionIdByTitle.set(listKey, sectionId);
      }
      for (const r of group.rows) {
        await addItem(sectionId, r.task);
        added++;
      }
    }
  }

  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent(`Imported ${added} task(s).`));
});

router.get('/setup/:day/tasks/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const sections = await taskListSectionsForDay(day);
  const lines = [toCsvRow(['List', 'Number', 'Task'])];
  sections.forEach((s) => {
    if (s.items.length === 0) {
      lines.push(toCsvRow([s.title, '', '']));
    } else {
      s.items.forEach((item) => lines.push(toCsvRow([s.title, item.number, item.description])));
    }
  });
  sendCsv(res, `${day}-task-list.csv`, lines);
});

router.get('/setup/:day/tasks/print', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  res.render('admin-setup-tasks-print', {
    title: `${DAY_LABELS[day]} Task List`,
    day,
    dayLabel: DAY_LABELS[day],
    sections: await taskListSectionsForDay(day),
  });
});

module.exports = router;
