const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAY_LABELS, defaultDay, requireDay } = require('../utils/days');
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

const uploadTasks = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// The landing page now lives on the combined Volunteers page, tabbed
// between Floater Assignments and Setup/Cleanup Teams.
router.get('/setup', requireAdmin, (req, res) => res.redirect(`/admin/setup/${defaultDay()}/manage`));

// --- Manage page: create/edit/delete teams, add/remove members per team ---

// Each team's own linked task list (if any - see task_list_sections.team_id)
// rides along so its numbered tasks can print right on that team's card
// (item 31).
function teamsWithMembers(day) {
  return teamsForDay(day).map((t) => ({ ...t, members: membersForTeam(t.id), taskSection: taskSectionForTeam(t.id) }));
}

router.get('/setup/:day/manage', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;

  res.render('admin-setup', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    day,
    dayLabel: DAY_LABELS[day],
    teams: teamsWithMembers(day),
    availableParents: activeParentOptions(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/setup/:day/teams', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  db.prepare('INSERT INTO setup_teams (day, title, description, leader_id) VALUES (?, ?, ?, ?)').run(day, title, description || null, leaderId);
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent(`Team "${title}" created.`));
});

// Leader dropdown auto-submits on change, same pattern as a Floater
// Teams rank select - no separate "edit" step.
router.post('/setup/:day/teams/:teamId/leader', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  setTeamLeader(teamId, leaderId);
  res.redirect(`/admin/setup/${day}/manage`);
});

// Team cards are view-only until Edit is clicked - title/description/
// leader all save together from that one popup, replacing the old
// inline-editable card.
router.post('/setup/:day/teams/:teamId/edit', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const leaderId = parseInt(req.body.leaderId, 10) || null;
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  updateTeam(teamId, { title, description, leaderId });
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent(`"${title}" updated.`));
});

router.post('/setup/:day/teams/:teamId/delete', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  db.prepare('DELETE FROM setup_teams WHERE id = ? AND day = ?').run(teamId, day);
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent('Team deleted.'));
});

// Single "+ Add Member" popup (toolbar, not per-card) - member + team
// dropdowns, so adding someone doesn't require opening a specific card.
router.post('/setup/:day/teams/add-member', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.body.teamId, 10);
  const memberId = parseInt(req.body.memberId, 10);
  if (teamId && memberId) {
    db.prepare('INSERT OR IGNORE INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);
  }
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent('Member added.'));
});

router.post('/setup/:day/teams/:teamId/remove-member/:memberId', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  db.prepare('DELETE FROM setup_team_members WHERE team_id = ? AND member_id = ?').run(teamId, memberId);
  res.redirect(`/admin/setup/${day}/manage`);
});

router.get('/setup/:day/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teams = teamsWithMembers(day);

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

router.get('/setup/:day/tasks', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  res.render('admin-setup-tasks', {
    title: `${DAY_LABELS[day]} Task List`,
    day,
    dayLabel: DAY_LABELS[day],
    sections: taskListSectionsForDay(day),
    teams: teamsForDay(day),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/setup/:day/tasks/new', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const teamId = parseInt(req.body.teamId, 10) || null;
  if (!title) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('List title is required.'));
  }
  createSection(day, title, teamId);
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent(`"${title}" created.`));
});

router.post('/setup/:day/tasks/:sectionId/delete', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  deleteSection(parseInt(req.params.sectionId, 10));
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent('List deleted.'));
});

router.post('/setup/:day/tasks/:sectionId/move', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const sectionId = parseInt(req.params.sectionId, 10);
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  swapSectionPosition(day, sectionId, direction);
  res.redirect(`/admin/setup/${day}/tasks`);
});

// Single "+ Add Task" popup (toolbar, not per-card) - description +
// which list dropdown, same pattern as Teams' "+ Add Member" popup.
router.post('/setup/:day/tasks/add-item', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const sectionId = parseInt(req.body.sectionId, 10);
  const description = (req.body.description || '').trim();
  if (!sectionId || !description) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('Choose a list and enter a task.'));
  }
  const section = getSection(sectionId);
  if (!section || section.day !== day) return res.redirect(`/admin/setup/${day}/tasks`);
  addItem(sectionId, description);
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent('Task added.'));
});

router.post('/setup/:day/tasks/:sectionId/items/:itemId/delete', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  deleteItem(parseInt(req.params.itemId, 10));
  res.redirect(`/admin/setup/${day}/tasks`);
});

router.post('/setup/:day/tasks/:sectionId/items/:itemId/move', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const sectionId = parseInt(req.params.sectionId, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  swapItemPosition(sectionId, itemId, direction);
  res.redirect(`/admin/setup/${day}/tasks`);
});

// Edit mode's one Save button - every section's title/team link and
// every item's description, all in one POST (see admin-setup-tasks.ejs).
// Reordering/deleting are their own immediate actions above, not part of
// this form.
router.post('/setup/:day/tasks/save', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  Object.keys(req.body).forEach((key) => {
    const sectionMatch = /^sectionTitle_(\d+)$/.exec(key);
    if (sectionMatch) {
      const id = parseInt(sectionMatch[1], 10);
      const section = getSection(id);
      if (!section || section.day !== day) return;
      const title = (req.body[key] || '').trim();
      const teamId = parseInt(req.body[`sectionTeam_${id}`], 10) || null;
      if (title) updateSection(id, { title, teamId });
      return;
    }
    const itemMatch = /^itemDesc_(\d+)$/.exec(key);
    if (itemMatch) {
      const id = parseInt(itemMatch[1], 10);
      const description = (req.body[key] || '').trim();
      if (description) updateItem(id, description);
    }
  });
  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent('Task list updated.'));
});

router.get('/setup/:day/tasks/import-template.xlsx', requireAdmin, requireDay, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['List', 'Task'],
    [
      ['Chairs & Tables', 'Set up 20 chairs in the main room'],
      ['Chairs & Tables', 'Fold and stack tables after use'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="task-list-import-template.xlsx"');
  res.send(buffer);
});

// Matches each row to an existing list by title (case-insensitive),
// creating the list (unlinked to any team) if it doesn't exist yet, then
// appends that row's task to the end of that list - Number is never
// imported, it's always just that row's position (see itemsForSection).
router.post('/setup/:day/tasks/import', requireAdmin, requireDay, uploadTasks.single('file'), (req, res) => {
  const day = req.params.day;
  if (!req.file) {
    return res.redirect(`/admin/setup/${day}/tasks?error=` + encodeURIComponent('Please choose a file to import.'));
  }
  const rows = readRowsFromFile(req.file.buffer);
  const sectionIdByTitle = new Map();
  taskListSectionsForDay(day).forEach((s) => sectionIdByTitle.set(s.title.toLowerCase(), s.id));

  let added = 0;
  for (const row of rows) {
    const keys = Object.keys(row);
    const listKey = keys.find((k) => k.trim().toLowerCase() === 'list');
    const taskKey = keys.find((k) => k.trim().toLowerCase() === 'task');
    const listTitle = listKey ? String(row[listKey]).trim() : '';
    const taskText = taskKey ? String(row[taskKey]).trim() : '';
    if (!listTitle || !taskText) continue;

    let sectionId = sectionIdByTitle.get(listTitle.toLowerCase());
    if (!sectionId) {
      sectionId = createSection(day, listTitle, null);
      sectionIdByTitle.set(listTitle.toLowerCase(), sectionId);
    }
    addItem(sectionId, taskText);
    added++;
  }

  res.redirect(`/admin/setup/${day}/tasks?notice=` + encodeURIComponent(`Imported ${added} task(s).`));
});

router.get('/setup/:day/tasks/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const sections = taskListSectionsForDay(day);
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

router.get('/setup/:day/tasks/print', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  res.render('admin-setup-tasks-print', {
    title: `${DAY_LABELS[day]} Task List`,
    day,
    dayLabel: DAY_LABELS[day],
    sections: taskListSectionsForDay(day),
  });
});

module.exports = router;
