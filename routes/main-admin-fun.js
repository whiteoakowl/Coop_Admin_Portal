// Main Admin's own read-only admin side of the Student Portal's "Fun"
// activities (Reading Challenge, Games, Vocabulary Game) - a real
// request: "nature news should be titled fun... these subpages, student
// reading challenge, parent reading challenge, games, vocabulary game.
// These subpages are the admin side to these pages that are on the
// parent and student portal already," scoped down to "simple read-only
// views" (no add/edit/delete here - utils/reading.js, utils/gameStats.js,
// and utils/spellingBee.js are already the single source of truth for
// the student/parent-facing pages that actually generate this data).
// Nature News itself keeps its own existing router/route
// (routes/admin-nature-news.js, mounted at /main-admin/nature-news) -
// this file is only the four brand new subpages, mounted at
// /main-admin/fun alongside it.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const db = require('../db');
const { POINTS_PER_HOUR } = require('../utils/reading');
const gameStats = require('../utils/gameStats');
const spellingBee = require('../utils/spellingBee');

router.use(requirePortalAuth, requirePortal('main_admin'));

// "Student Reading Challenge = table of all students' reading logs/
// goals" - one row per active student, aggregated rather than N+1
// queries per student.
router.get('/reading-challenge/students', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT m.id, m.name, COALESCE(SUM(rl.hours), 0) AS "totalHours", COUNT(rl.id) AS "logCount", COALESCE(rg.weekly_goal_hours, 7) AS "weeklyGoalHours"
       FROM members m
       LEFT JOIN reading_logs rl ON rl.member_id = m.id
       LEFT JOIN reading_goals rg ON rg.member_id = m.id
       WHERE m.member_type = 'student' AND m.active = 1
       GROUP BY m.id, m.name, rg.weekly_goal_hours
       ORDER BY "totalHours" DESC, m.name`
    )
    .all();
  const students = rows.map((r) => ({ ...r, totalHours: Number(r.totalHours), totalPoints: Math.round(Number(r.totalHours) * POINTS_PER_HOUR) }));
  res.render('main-admin-reading-challenge', { title: 'Student Reading Challenge', heading: 'Student Reading Challenge', groupByFamily: false, students });
});

// "Parent Reading Challenge = same data, family-grouped view" - same
// query, scoped to parents, plus each parent's family name to group by
// in the view.
router.get('/reading-challenge/parents', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT m.id, m.name, f.name AS "familyName", COALESCE(SUM(rl.hours), 0) AS "totalHours", COUNT(rl.id) AS "logCount", COALESCE(rg.weekly_goal_hours, 7) AS "weeklyGoalHours"
       FROM members m
       LEFT JOIN families f ON f.id = m.family_id
       LEFT JOIN reading_logs rl ON rl.member_id = m.id
       LEFT JOIN reading_goals rg ON rg.member_id = m.id
       WHERE m.member_type = 'parent' AND m.active = 1
       GROUP BY m.id, m.name, f.name, rg.weekly_goal_hours
       ORDER BY COALESCE(f.name, 'zzz'), m.name`
    )
    .all();
  const students = rows.map((r) => ({ ...r, totalHours: Number(r.totalHours), totalPoints: Math.round(Number(r.totalHours) * POINTS_PER_HOUR) }));
  res.render('main-admin-reading-challenge', { title: 'Parent Reading Challenge', heading: 'Parent Reading Challenge', groupByFamily: true, students });
});

// "Games = table of game play/score activity" - the most recent plays
// (any of the 15 games) plus the current top scorer for each of the 6
// that report a score (utils/gameStats.js's own SCORING_GAMES).
router.get('/games', async (req, res) => {
  const [topScores, recentPlays] = await Promise.all([
    gameStats.topScorePerGame(),
    db
      .prepare(
        `SELECT gp.game_key AS "gameKey", gp.played_at AS "playedAt", m.name
         FROM game_plays gp JOIN members m ON m.id = gp.member_id
         ORDER BY gp.played_at DESC LIMIT 100`
      )
      .all(),
  ]);
  const gameTitle = (key) => gameStats.SCORING_GAMES[key] || key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  res.render('main-admin-games', {
    title: 'Games',
    topScores,
    recentPlays: recentPlays.map((p) => ({ ...p, gameTitle: gameTitle(p.gameKey) })),
  });
});

// "Vocabulary Game = view of spelling-bee scores + the (hardcoded, not
// DB-backed) word lists" - utils/spellingBee.js's own ELEMENTARY_WORDS/
// MIDDLE_WORDS/HIGH_WORDS are plain constants, not a table, so there's
// nothing to query for them beyond wordsForLevel() itself.
router.get('/vocabulary-game', async (req, res) => {
  const topPlayers = await spellingBee.topPlayers(20);
  const wordLists = Object.keys(spellingBee.LEVEL_LABELS).map((level) => ({
    level,
    label: spellingBee.LEVEL_LABELS[level],
    words: spellingBee.wordsForLevel(level),
  }));
  res.render('main-admin-vocabulary-game', { title: 'Vocabulary Game', topPlayers, wordLists });
});

module.exports = router;
