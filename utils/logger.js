// The app's only error visibility today is console.error - fine while
// someone's watching the terminal window this runs in (the typical
// deployment, see SETUP.md), useless the moment that window is closed or
// scrolled past. This gives an admin something concrete to look at (or
// send along in a bug report) after the fact, without asking them to run
// anything or understand what a stack trace is - just open a text file.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Overridable the same way db/index.js's DB_PATH is, so tests can point
// this at a throwaway file instead of the real data/error.log.
const LOG_PATH = process.env.ERROR_LOG_PATH || path.join(DATA_DIR, 'error.log');

// Keeps the log from growing forever on a kiosk machine nobody's actively
// managing. This isn't meant to be a full audit trail - just enough
// recent history to be useful. Once the file passes this size, the
// oldest half is dropped.
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB

function logError(context, err) {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    fs.appendFileSync(LOG_PATH, `[${timestamp}] ${context}\n${detail}\n\n`);
    trimIfNeeded();
  } catch (loggingErr) {
    // Logging must never be the thing that takes the app down - if the
    // disk is full or the file can't be written, fall back to the
    // console the caller already writes to and move on.
    console.error('Failed to write to error.log:', loggingErr.message);
  }
}

function trimIfNeeded() {
  const stat = fs.statSync(LOG_PATH);
  if (stat.size <= MAX_LOG_BYTES) return;
  const content = fs.readFileSync(LOG_PATH, 'utf8');
  const tail = content.slice(content.length - Math.floor(MAX_LOG_BYTES / 2));
  // Drop everything up through the first entry boundary in what's left,
  // so the trimmed file starts cleanly at a "[timestamp]" line instead of
  // mid-stack-trace.
  const boundary = tail.indexOf('\n[');
  fs.writeFileSync(LOG_PATH, boundary === -1 ? tail : tail.slice(boundary + 1));
}

module.exports = { logError, LOG_PATH };
