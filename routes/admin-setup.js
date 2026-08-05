const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAY_LABELS, defaultDay, requireDay } = require('../utils/days');
const { teamsForDay, membersForTeam } = require('../utils/setup');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');

// The landing page now lives on the combined Volunteers page, tabbed
// between Floater Assignments and Setup/Cleanup Teams.
router.get('/setup', requireAdmin, (req, res) => res.redirect(`/admin/setup/${defaultDay()}/manage`));

// --- Manage page: create/edit/delete teams, add/remove members per team ---

function teamsWithMembers(day) {
  // Setup/Cleanup teams are staffed by parent volunteers, not students.
  const allActiveMembers = db
    .prepare("SELECT * FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY name COLLATE NOCASE")
    .all();

  return teamsForDay(day).map((t) => {
    const members = membersForTeam(t.id);
    const memberIds = members.map((m) => m.id);
    return {
      ...t,
      members,
      availableMembers: allActiveMembers.filter((m) => !memberIds.includes(m.id)),
    };
  });
}

router.get('/setup/:day/manage', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;

  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    tab: 'setup',
    day,
    dayLabel: DAY_LABELS[day],
    teams: teamsWithMembers(day),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/setup/:day/teams', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  db.prepare('INSERT INTO setup_teams (day, title, description) VALUES (?, ?, ?)').run(day, title, description || null);
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent(`Team "${title}" created.`));
});

router.post('/setup/:day/teams/:teamId/edit', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) {
    return res.redirect(`/admin/setup/${day}/manage?error=` + encodeURIComponent('Team title is required.'));
  }
  db.prepare('UPDATE setup_teams SET title = ?, description = ? WHERE id = ? AND day = ?').run(title, description || null, teamId, day);
  res.redirect(`/admin/setup/${day}/manage`);
});

router.post('/setup/:day/teams/:teamId/delete', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  db.prepare('DELETE FROM setup_teams WHERE id = ? AND day = ?').run(teamId, day);
  res.redirect(`/admin/setup/${day}/manage?notice=` + encodeURIComponent('Team deleted.'));
});

router.post('/setup/:day/teams/:teamId/add-member', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const link = db.prepare('INSERT OR IGNORE INTO setup_team_members (team_id, member_id) VALUES (?, ?)');
  for (const memberId of memberIds) link.run(teamId, memberId);
  res.redirect(`/admin/setup/${day}/manage`);
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

module.exports = router;
