// The small generic key/value table backing every one-off co-op-wide
// setting that doesn't deserve its own column/table (the Class Check-In
// PIN, the Kiosk's active semester, etc.) - a standalone leaf module (no
// dependency on utils/classSchedule.js or utils/volunteers.js) so modules
// on both sides of that relationship (e.g. utils/kioskSettings.js, needed
// by utils/volunteers.js, which utils/classSchedule.js itself depends on)
// can both reach it without a circular require.
const db = require('../db');

async function appSetting(key, fallback) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

async function setAppSetting(key, value) {
  await db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

module.exports = { appSetting, setAppSetting };
