const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAY_LABELS, defaultDay, requireDay, defaultDateFor, parseDayValue } = require('../utils/days');
const { absentMemberIdsForDate } = require('../utils/classSchedule');
const { teamsForDay, membersForTeam, setTeamLeader, updateTeam } = require('../utils/setup');
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
  taskSectionForTeam,
} = require('../utils/taskList');
const { toCsvRow, sendCsv, readRowsFromFile, buildTemplateWorkbook } = require('../utils/spreadsheet');
const { activeParentOptions } = require('../utils/members');
const { spreadsheetFileFilter } = require('../utils/uploads');

const uploadTasks = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

// The landing page now lives on the combined Volunteers page, tabbed
// between Floater Assignments and Setup/Cleanup Teams.
router.get('/setup', requireAdmin, (req, res) => res.redirect(`/admin/setup/${defaultDay()}/manage`));

// --- Manage page: create/edit/delete teams, add/remove members per team ---

// Each team's own linked task list (if any - see task_list_sections.team_id)
// rides along so its numbered tasks can print right on that team's card
// (item 31).
async function teamsWithMembers(day) {
  const teams = await teamsForDay(day);
  const result = [];
  for (const t of teams) {
    result.push({ ...t, members: await membersForTeam(t.id), taskSection: await taskSectionForTeam(t.id) });
  }
  return result;
}

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
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  await db.prepare('INSERT INTO setup_teams (day, title, description, leader_id) VALUES (?, ?, ?, ?)').run(day, title, description || null, leaderId);
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
// leader all save together from that one popup, replacing the old
// inline-editable card.
router.post('/setup/:day/teams/:teamId/edit', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  await updateTeam(teamId, { title, description, leaderId });
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
