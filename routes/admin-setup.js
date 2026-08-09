const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAY_LABELS, defaultDay, requireDay } = require('../utils/days');
const { teamsForDay, membersForTeam, setTeamLeader, updateTeam } = require('../utils/setup');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { activeParentOptions } = require('../utils/members');

// The landing page now lives on the combined Volunteers page, tabbed
// between Floater Assignments and Setup/Cleanup Teams.
router.get('/setup', requireAdmin, (req, res) => res.redirect(`/admin/setup/${defaultDay()}/manage`));

// --- Manage page: create/edit/delete teams, add/remove members per team ---

function teamsWithMembers(day) {
  return teamsForDay(day).map((t) => ({ ...t, members: membersForTeam(t.id) }));
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

module.exports = router;
