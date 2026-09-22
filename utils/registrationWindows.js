// Staged, group-targeted class registration windows (see the
// registration_windows migration's own header comment for the full
// rationale). A window targets an existing role key, or null for
// "everyone". Shared by routes/main-admin.js (managing windows) and
// routes/parent-portal.js (enforcing them at registration time).
const db = require('../db');

async function listWindows() {
  return db
    .prepare(
      `SELECT w.*, r.label AS "roleLabel", s.name AS "sectionName" FROM registration_windows w
       LEFT JOIN roles r ON r.key = w.role_key
       LEFT JOIN sections s ON s.id = w.section_id
       ORDER BY w.opens_at`
    )
    .all();
}

async function createWindow({ label, roleKey, opensAt, closesAt, day, sectionId }) {
  await db
    .prepare('INSERT INTO registration_windows (label, role_key, opens_at, closes_at, day, section_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(label, roleKey || null, opensAt, closesAt || null, day || null, sectionId || null);
}

async function deleteWindow(id) {
  await db.prepare('DELETE FROM registration_windows WHERE id = ?').run(id);
}

// Whether class registration is currently open to this account. No
// windows defined at all means every class's own registration_open flag
// is the only gate (the original, pre-windows behavior) - a co-op that
// never sets up staged windows sees no change at all. Once at least one
// window exists, an account qualifies once it's inside a window that
// targets no particular role/day/section (open to everyone) or matches
// every one of the ones it does target. `day` ('monday'/'wednesday') and
// `sectionIds` (the CLASS's own section restriction, from
// classSectionIds - not the member's) narrow a window to one schedule
// grid / one Sections group; omit either to check across all of them
// (used by page-level "is anything open" banners that aren't scoped to
// one class).
async function isRegistrationOpenForAccount(accountRoles, { day, sectionIds } = {}) {
  const windows = await db.prepare('SELECT role_key, opens_at, closes_at, day, section_id FROM registration_windows').all();
  if (windows.length === 0) return true;

  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  const roleKeys = new Set(accountRoles.map((r) => r.key));
  return windows.some((w) => {
    if (w.role_key && !roleKeys.has(w.role_key)) return false;
    if (w.day && day !== undefined && w.day !== day) return false;
    if (w.section_id && sectionIds !== undefined && !sectionIds.includes(w.section_id)) return false;
    if (nowText < w.opens_at) return false;
    if (w.closes_at && nowText >= w.closes_at) return false;
    return true;
  });
}

// The earliest not-yet-closed window that applies to this account (its
// own role, or a role-less "everyone" window), whether or not it has
// opened yet - lets the Classes page tell a parent *when* registration
// opens for them, not just that it isn't open yet. Null once no windows
// exist at all, or every window that applies to this account has already
// closed.
async function nextWindowForAccount(accountRoles, { day, sectionIds } = {}) {
  const windows = await listWindows();
  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  const roleKeys = new Set(accountRoles.map((r) => r.key));
  const applicable = windows
    .filter((w) => !w.role_key || roleKeys.has(w.role_key))
    .filter((w) => !w.day || day === undefined || w.day === day)
    .filter((w) => !w.section_id || sectionIds === undefined || sectionIds.includes(w.section_id))
    .filter((w) => !w.closes_at || nowText < w.closes_at);
  if (applicable.length === 0) return null;
  return applicable.reduce((earliest, w) => (w.opens_at < earliest.opens_at ? w : earliest));
}

module.exports = { listWindows, createWindow, deleteWindow, isRegistrationOpenForAccount, nextWindowForAccount };
