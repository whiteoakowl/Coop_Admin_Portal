// Student Portal > Games header stats (Games Played / High Score /
// Current Streak) - a real request: "include games played, high score,
// current streak bar at the top right." Same "compute on read"
// philosophy as utils/reading.js/utils/pets.js: everything here derives
// from the raw game_plays/game_scores rows (see this migration's own
// header comment: 20260830030000_game_stats.sql) rather than a mutable
// counter that could drift.
const db = require('../db');

// Only games with a genuinely comparable numeric result report a score
// (see the migration's own note on why this doesn't try to make points
// vs. words-per-minute directly comparable beyond "which number is
// bigger") - every other game (Chess, Checkers, Solitaire, etc.) only
// ever logs a play, never a score.
const SCORING_GAMES = {
  snake: 'Snake',
  'avoid-obstacles': 'Avoid the Obstacles',
  trivia: 'Trivia Quiz',
  'typing-race': 'Typing Race',
  'riddle-rush': 'Riddle Rush',
  'word-scramble': 'Word Scramble',
};

async function logPlay(memberId, gameKey) {
  await db.prepare('INSERT INTO game_plays (member_id, game_key) VALUES (?, ?)').run(memberId, gameKey);
}

async function logScore(memberId, gameKey, score) {
  if (!SCORING_GAMES[gameKey]) return { ok: false, error: 'This game does not report a score.' };
  const clean = Math.max(0, Math.min(999999, Math.round(Number(score) || 0)));
  await db.prepare('INSERT INTO game_scores (member_id, game_key, score) VALUES (?, ?, ?)').run(memberId, gameKey, clean);
  return { ok: true };
}

// Consecutive calendar days (UTC, counting back from today) with at
// least one logged play - identical shape to reading.js's currentStreak,
// just reading dates out of a timestamp column instead of a plain date one.
function currentStreak(plays) {
  const days = new Set(plays.map((p) => p.played_at.slice(0, 10)));
  let streak = 0;
  const cursor = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

async function statsForMember(memberId) {
  const plays = await db.prepare('SELECT game_key, played_at FROM game_plays WHERE member_id = ?').all(memberId);
  const topScores = await db.prepare('SELECT game_key, score FROM game_scores WHERE member_id = ? ORDER BY score DESC LIMIT 1').all(memberId);
  const best = topScores[0] || null;
  return {
    gamesPlayed: plays.length,
    streak: currentStreak(plays),
    highScore: best ? { score: best.score, gameTitle: SCORING_GAMES[best.game_key] || best.game_key } : null,
  };
}

// Leaderboard's "top player for each game" - the best logged score per
// scoring game, across every active student. Same "compute on read"
// shape as reading.js/spellingBee.js's own leaderboard queries: one
// query for the raw rows, ranked in JS rather than a per-game query.
// Ties break by whoever reached that score first.
async function topScorePerGame() {
  const rows = await db
    .prepare(
      `SELECT gs.game_key, gs.score, gs.achieved_at, m.id AS member_id, m.name
       FROM game_scores gs
       JOIN members m ON m.id = gs.member_id
       WHERE m.member_type = 'student' AND m.active = 1`
    )
    .all();
  const best = {};
  rows.forEach((row) => {
    const current = best[row.game_key];
    if (!current || row.score > current.score || (row.score === current.score && row.achieved_at < current.achieved_at)) {
      best[row.game_key] = row;
    }
  });
  return Object.keys(SCORING_GAMES).map((key) => {
    const row = best[key];
    return {
      gameKey: key,
      gameTitle: SCORING_GAMES[key],
      memberId: row ? row.member_id : null,
      name: row ? row.name : null,
      score: row ? row.score : null,
    };
  });
}

module.exports = { logPlay, logScore, statsForMember, topScorePerGame, SCORING_GAMES };
