const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { DAYS, DAY_LABELS, isValidDay } = require('../utils/days');
const { teamsForDay, membersForTeam } = require('../utils/setup');

function requireDay(req, res, next) {
  if (!isValidDay(req.params.day)) return res.status(404).send('Not found');
  next();
}

// --- Landing page: two cards, one per day. No linking step - teams just
// belong to a day and show up on that day's page automatically. ---

router.get('/setup', requireAdmin, (req, res) => {
  const cards = DAYS.map((day) => ({
    day,
    label: DAY_LABELS[day],
    teamCount: teamsForDay(day).length,
  }));
  res.render('admin-setup', { title: 'Setup/Cleanup', cards });
});

// --- Manage page: create/edit/delete teams, add/remove members per team ---

router.get('/setup/:day/manage', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const allActiveMembers = db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE').all();

  const teams = teamsForDay(day).map((t) => {
    const members = membersForTeam(t.id);
    const memberIds = members.map((m) => m.id);
    return {
      ...t,
      members,
      availableMembers: allActiveMembers.filter((m) => !memberIds.includes(m.id)),
    };
  });

  res.render('admin-setup-manage', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    day,
    dayLabel: DAY_LABELS[day],
    teams,
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
  const memberId = parseInt(req.body.memberId, 10);
  if (memberId) {
    db.prepare('INSERT OR IGNORE INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);
  }
  res.redirect(`/admin/setup/${day}/manage`);
});

router.post('/setup/:day/teams/:teamId/remove-member/:memberId', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const teamId = parseInt(req.params.teamId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  db.prepare('DELETE FROM setup_team_members WHERE team_id = ? AND member_id = ?').run(teamId, memberId);
  res.redirect(`/admin/setup/${day}/manage`);
});

module.exports = router;
