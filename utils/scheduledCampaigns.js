// A real request: "Scheduling text to be sent later. Repair this
// feature so that when it is scheduled it will automatically send
// according to that schedule instead of having to come back and click
// send manually." Before this, "Schedule Later" only ever saved a
// text_campaigns row with status='scheduled' - nothing ever read it
// back out again except an admin manually clicking the Send button on
// POST /text/:id/send (routes/main-admin-announcements.js /
// routes/admin-announcements.js).
//
// This app has no persistent background process to run a real cron job
// on (see netlify.toml's own header comment - it's one stateless
// Netlify Function per request) and no new recurring-job infrastructure
// is being added just for this - instead, every request opportunistically
// checks for and fires any due campaign, debounced in-process so a busy
// portal doesn't re-run this query on every single request. A cold
// Netlify Function start resets the debounce to 0, so the very first
// request after a cold start always checks - the safer failure mode
// (checking slightly more often, not less) for getting a scheduled
// text out close to on time.
const db = require('../db');
const textComposer = require('./textComposer');

const CHECK_INTERVAL_MS = 60 * 1000;
let lastCheckedAt = 0;

async function dispatchDueTextCampaigns(nowMs = Date.now()) {
  if (nowMs - lastCheckedAt < CHECK_INTERVAL_MS) return;
  lastCheckedAt = nowMs;
  const due = await db.prepare("SELECT id FROM text_campaigns WHERE status = 'scheduled' AND scheduled_at <= now_text()").all();
  for (const row of due) {
    await textComposer.sendScheduled(row.id);
  }
}

// Test-only: lets a test force the next dispatchDueTextCampaigns() call
// to actually run instead of waiting out the real 60s debounce.
function resetDebounceForTest() {
  lastCheckedAt = 0;
}

module.exports = { dispatchDueTextCampaigns, resetDebounceForTest };
