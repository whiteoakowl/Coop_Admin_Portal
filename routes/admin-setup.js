const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAY_LABELS, defaultDay, requireDay, defaultDateFor, parseDayValue } = require('../utils/days');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { absentMemberIdsForDate } = require('../utils/classSchedule');
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
  addItem,
  updateItem,
  deleteItem,
  swapItemPosition,
} = require('../utils/taskList');
const { toCsvRow, sendCsv, readRowsFromFile, buildTemplateWorkbook } = require('../utils/spreadsheet');
const { activeParentOptions } = require('../utils/members');
const { spreadsheetFileFilter } = require('../utils/uploads');

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
    availableParents: await activeParentOptions(),
    // Only actually highlights anyone when today falls on this day - no
    // date picker here (teams are a standing weekly roster, not tied to a
    // specific date the admin chooses), so "absent that day" means "absent
    // today" and only has anything to show while today matches the tab.
    absentIds: await absentMemberIdsForDate(defaultDateFor(day)),
    error: req.query.error || null,
    notice: req.query.notice || null,
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
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  await db
    .prepare('INSERT INTO setup_teams (day, title, description, leader_id, meeting_time, meeting_location) VALUES (?, ?, ?, ?, ?, ?)')
    .run(day, title, description || null, leaderId, meetingTime || null, meetingLocation || null);
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
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  await updateTeam(teamId, { title, description, leaderId, meetingTime, meetingLocation });
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

router.post('/setup/:day/teams/:teamId/remove-member/:memberId', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  await db.prepare('DELETE FROM setup_team_members WHERE team_id = ? AND member_id = ?').run(teamId, memberId);
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

router.post('/setup/:day/dates/add', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  await addSetupDates(day, dates);
  res.redirect(`/admin/setup/${day}/assignments?notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/setup/:day/dates/:date/remove', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  await removeSetupDate(day, date);
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
router.post('/setup/:day/assignments/:memberId/task', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const memberId = parseInt(req.params.memberId, 10);
  const date = req.body.date;
  const slot = req.body.slot === '2' ? 2 : 1;
  const taskItemId = parseInt(req.body.taskItemId, 10) || null;
  if (date && isValidISODate(date)) await setTaskAssignment(day, memberId, date, slot, taskItemId);
  res.redirect(`/admin/setup/${day}/assignments` + (date ? `?date=${encodeURIComponent(date)}` : ''));
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

// Edit mode's one Save button - every section's title/team link and
// every item's description, all in one POST (see admin-setup-tasks.ejs).
// Reordering/deleting are their own immediate actions above, not part of
// this form.
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
