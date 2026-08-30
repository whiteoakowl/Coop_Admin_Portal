// Student Portal > Reading Competition - a real request: "there will be a
// reading log on this page for students to fill out and earn points.
// students will compete with other students. match the reading
// competition dashboard image exactly. using my colors." The reference
// mockup is a generic "LearnHub" dashboard (indigo/purple palette, its
// own left sidebar) - this app reuses its own existing student-portal
// nav/chrome and public/css/styles.css's own --brand/--purple/--green/
// --yellow tokens instead of the reference's colors, but mirrors its
// layout: stat cards, a log-entry form, a recent-entries list, a weekly
// goal panel, and an achievements list. See the reading_logs migration's
// own header comment for why points/streak/level/achievements are all
// computed here from the raw log rows rather than stored as mutable
// counters (same "compute on read" approach as utils/pets.js's care
// stats).
const db = require('../db');

const POINTS_PER_HOUR = 10;
const WEEKLY_GOAL_HOURS = 7;
const XP_PER_LEVEL = 500;

async function logsForMember(memberId) {
  return db.prepare('SELECT * FROM reading_logs WHERE member_id = ? ORDER BY log_date DESC, id DESC').all(memberId);
}

// Per-student weekly goal (a real request: "is there a button for
// setting your reading goal?") - missing row just means the default,
// same "compute on read, no row required up front" spirit as the rest
// of this file (see this migration's own header comment:
// 20260830040000_reading_goal.sql).
async function getWeeklyGoal(memberId) {
  const row = await db.prepare('SELECT weekly_goal_hours FROM reading_goals WHERE member_id = ?').get(memberId);
  return row ? Number(row.weekly_goal_hours) : WEEKLY_GOAL_HOURS;
}

async function setWeeklyGoal(memberId, hours) {
  const clean = Math.min(100, Math.max(1, Number(hours) || 0));
  if (!clean) return { ok: false, error: 'Enter a valid weekly goal.' };
  await db
    .prepare(
      `INSERT INTO reading_goals (member_id, weekly_goal_hours, updated_at) VALUES (?, ?, now_text())
       ON CONFLICT (member_id) DO UPDATE SET weekly_goal_hours = excluded.weekly_goal_hours, updated_at = excluded.updated_at`
    )
    .run(memberId, clean);
  return { ok: true, hours: clean };
}

async function addLog(memberId, { bookTitle, hours, notes, logDate }) {
  const cleanTitle = (bookTitle || '').trim().slice(0, 200);
  const cleanHours = Math.min(24, Math.max(0.25, Number(hours) || 0));
  const cleanNotes = (notes || '').trim().slice(0, 500) || null;
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(logDate || '') ? logDate : new Date().toISOString().slice(0, 10);
  if (!cleanTitle) return { ok: false, error: 'Book title is required.' };

  await db
    .prepare('INSERT INTO reading_logs (member_id, book_title, hours, notes, log_date) VALUES (?, ?, ?, ?, ?)')
    .run(memberId, cleanTitle, cleanHours, cleanNotes, cleanDate);
  return { ok: true, points: Math.round(cleanHours * POINTS_PER_HOUR) };
}

function totalHours(logs) {
  return logs.reduce((sum, log) => sum + Number(log.hours), 0);
}

function totalPoints(logs) {
  return Math.round(totalHours(logs) * POINTS_PER_HOUR);
}

// Sunday-start week, matching the reference's "This Week" card.
function startOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function hoursThisWeek(logs) {
  const weekStart = startOfWeek(new Date());
  return logs.reduce((sum, log) => {
    const logDate = new Date(log.log_date + 'T00:00:00Z');
    return logDate >= weekStart ? sum + Number(log.hours) : sum;
  }, 0);
}

// Consecutive calendar days (by log_date, at least one entry each day)
// counting back from today; a gap of a day or more ends the streak.
function currentStreak(logs) {
  const days = new Set(logs.map((log) => log.log_date));
  let streak = 0;
  const cursor = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function levelInfo(points) {
  const level = Math.floor(points / XP_PER_LEVEL) + 1;
  const xpIntoLevel = points % XP_PER_LEVEL;
  return { level, xpIntoLevel, xpForLevel: XP_PER_LEVEL };
}

// Four fixed badges matching the reference's own set; each is a simple
// threshold check against the log rows, re-evaluated on every view (no
// "earned_at" row to maintain).
function achievements(logs) {
  const hours = totalHours(logs);
  const streak = currentStreak(logs);
  const nightOwl = logs.some((log) => {
    const hour = new Date(log.created_at.replace(' ', 'T') + 'Z').getUTCHours();
    return hour >= 20 || hour < 4;
  });
  return [
    { key: 'week-warrior', icon: 'flame', label: 'Week Warrior', detail: 'Read for 7 days in a row', done: streak >= 7, progress: Math.min(streak, 7), goal: 7, unit: 'days', color: 'orange' },
    { key: 'bookworm', icon: 'book', label: 'Bookworm', detail: 'Log 25 total hours', done: hours >= 25, progress: Math.min(Math.round(hours), 25), goal: 25, unit: 'hours', color: 'blue' },
    { key: 'page-turner', icon: 'book', label: 'Page Turner', detail: 'Log 50 total hours', done: hours >= 50, progress: Math.min(Math.round(hours), 50), goal: 50, unit: 'hours', color: 'purple' },
    { key: 'night-owl', icon: 'star', label: 'Night Owl', detail: 'Read after 8 PM', done: nightOwl, progress: nightOwl ? 1 : 0, goal: 1, unit: 'times', color: 'green' },
  ];
}

// A small deterministic "book cover" color swatch (first-letter tile) in
// place of real cover art - there's no book-cover image source to pull
// from, so this substitutes a stable, title-derived accent color rather
// than a plain gray box for every entry.
const COVER_COLORS = ['#7c5ce8', '#4a90d9', '#16a34a', '#e35d5d', '#e8934a', '#b969c9', '#5a9451'];
function coverColor(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  return COVER_COLORS[hash % COVER_COLORS.length];
}

async function dashboardForMember(memberId) {
  const logs = await logsForMember(memberId);
  const hours = totalHours(logs);
  const points = totalPoints(logs);
  const weekHours = hoursThisWeek(logs);
  const weeklyGoalHours = await getWeeklyGoal(memberId);
  return {
    logs: logs.slice(0, 5),
    moreLogs: logs.slice(5, 50),
    totalHours: hours,
    totalPoints: points,
    weekHours,
    weeklyGoalHours,
    weeklyGoalPct: Math.min(100, Math.round((weekHours / weeklyGoalHours) * 100)),
    streak: currentStreak(logs),
    levelInfo: levelInfo(points),
    achievements: achievements(logs),
    pointsPerHour: POINTS_PER_HOUR,
  };
}

// "students will compete with other students" - every active student
// member ranked by all-time points, regardless of family/class (this
// app has no notion of reading "sections" to scope it further).
async function leaderboard(limit = 10) {
  const rows = await db
    .prepare(
      `SELECT m.id AS member_id, m.name, COALESCE(SUM(rl.hours), 0) AS hours
       FROM members m
       LEFT JOIN reading_logs rl ON rl.member_id = m.id
       WHERE m.member_type = 'student' AND m.active = 1
       GROUP BY m.id, m.name
       HAVING COALESCE(SUM(rl.hours), 0) > 0
       ORDER BY hours DESC
       LIMIT ?`
    )
    .all(limit);
  return rows.map((row, index) => ({
    rank: index + 1,
    memberId: row.member_id,
    name: row.name,
    hours: Number(row.hours),
    points: Math.round(Number(row.hours) * POINTS_PER_HOUR),
  }));
}

module.exports = {
  POINTS_PER_HOUR,
  WEEKLY_GOAL_HOURS,
  addLog,
  dashboardForMember,
  leaderboard,
  coverColor,
  getWeeklyGoal,
  setWeeklyGoal,
};
