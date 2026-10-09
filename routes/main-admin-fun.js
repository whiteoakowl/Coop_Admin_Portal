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
const { POINTS_PER_HOUR, GRADE_BANDS, gradeBandForGradeLevel } = require('../utils/reading');
const gameStats = require('../utils/gameStats');
const spellingBee = require('../utils/spellingBee');
const pets = require('../utils/pets');

router.use(requirePortalAuth, requirePortal('main_admin'));

// "Student Reading Challenge = table of all students' reading logs/
// goals" - one row per active student, aggregated rather than N+1
// queries per student.
//
// A real request: "student reading challenge divide into separate cards
// by grade level sections... top card shows highest person from each
// grade sections." grade_level is pulled in just for this bucketing -
// gradeBandForGradeLevel (utils/reading.js) sorts each student into one
// of the 6 fixed bands, or null for no/unrecognized grade on file, which
// gets its own small "Ungraded" bucket rather than being silently
// dropped. Rows are already ordered by totalHours DESC, so each band's
// own list - and therefore its first entry, the band's top student -
// falls out of that same order for free.
router.get('/reading-challenge/students', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT m.id, m.name, m.grade_level AS "gradeLevel", COALESCE(SUM(rl.hours), 0) AS "totalHours", COUNT(rl.id) AS "logCount", COALESCE(rg.weekly_goal_hours, 7) AS "weeklyGoalHours"
       FROM members m
       LEFT JOIN reading_logs rl ON rl.member_id = m.id
       LEFT JOIN reading_goals rg ON rg.member_id = m.id
       WHERE m.member_type = 'student' AND m.active = 1
       GROUP BY m.id, m.name, m.grade_level, rg.weekly_goal_hours
       ORDER BY "totalHours" DESC, m.name`
    )
    .all();
  const students = rows.map((r) => ({ ...r, totalHours: Number(r.totalHours), totalPoints: Math.round(Number(r.totalHours) * POINTS_PER_HOUR) }));

  const gradeBands = GRADE_BANDS.map((band) => ({ ...band, students: [] }));
  const ungraded = [];
  students.forEach((s) => {
    const band = gradeBandForGradeLevel(s.gradeLevel);
    const bucket = band ? gradeBands.find((b) => b.key === band.key) : null;
    (bucket ? bucket.students : ungraded).push(s);
  });
  // "Top card shows highest person from each grade sections" means the 6
  // named sections specifically - computed before the Ungraded bucket
  // (below) is appended, so a student with no grade on file never shows
  // up in this summary card.
  const topByBand = gradeBands.filter((b) => b.students.length).map((b) => ({ label: b.label, student: b.students[0] }));
  if (ungraded.length) gradeBands.push({ key: 'ungraded', label: 'Ungraded', students: ungraded });

  res.render('main-admin-reading-challenge', { title: 'Student Reading Challenge', heading: 'Student Reading Challenge', groupByFamily: false, students, gradeBands, topByBand });
});

// "Parent Reading Challenge = same data, family-grouped view" - same
// query, scoped to parents, plus each parent's family name to group by
// in the view. A real request also added "a top card that shows top 10
// adult with the most hours" - same rows, just re-sorted by hours and
// sliced rather than a second query. member_type IN ('parent', 'admin') -
// a real request: "if a member is an admin they still have the same
// member privileges as a parent... can complete games, lessons,
// activities, anything," the same "admin counts as parent" convention
// every other adult-scoped query in this app already uses.
router.get('/reading-challenge/parents', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT m.id, m.name, f.name AS "familyName", COALESCE(SUM(rl.hours), 0) AS "totalHours", COUNT(rl.id) AS "logCount", COALESCE(rg.weekly_goal_hours, 7) AS "weeklyGoalHours"
       FROM members m
       LEFT JOIN families f ON f.id = m.family_id
       LEFT JOIN reading_logs rl ON rl.member_id = m.id
       LEFT JOIN reading_goals rg ON rg.member_id = m.id
       WHERE m.member_type IN ('parent', 'admin') AND m.active = 1
       GROUP BY m.id, m.name, f.name, rg.weekly_goal_hours
       ORDER BY COALESCE(f.name, 'zzz'), m.name`
    )
    .all();
  const students = rows.map((r) => ({ ...r, totalHours: Number(r.totalHours), totalPoints: Math.round(Number(r.totalHours) * POINTS_PER_HOUR) }));
  const topAdults = [...students]
    .filter((s) => s.totalHours > 0)
    .sort((a, b) => b.totalHours - a.totalHours)
    .slice(0, 10);
  res.render('main-admin-reading-challenge', { title: 'Parent Reading Challenge', heading: 'Parent Reading Challenge', groupByFamily: true, students, topAdults });
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

// "Pets = read-only view of the Student Portal's virtual pet activity" -
// one row per student who has created a pet (utils/pets.js's own
// careStats()/levelInfo() compute the same derived stats the student
// page itself shows, so there's nothing new to compute here).
router.get('/pets', async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT sp.*, m.name AS "memberName"
       FROM student_pets sp JOIN members m ON m.id = sp.member_id
       ORDER BY sp.xp DESC, m.name`
    )
    .all();
  const petRows = rows.map((r) => ({
    memberName: r.memberName,
    petName: r.name,
    look: pets.lookByKey(r.look),
    stats: pets.careStats(r),
    levelInfo: pets.levelInfo(r.xp),
    coins: r.coins,
  }));
  res.render('main-admin-pets', { title: 'Pets', petRows });
});

module.exports = router;
