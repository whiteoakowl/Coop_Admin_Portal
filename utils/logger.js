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
  // A real Netlify Function log: every single error entry was followed
  // by its own "Failed to write to error.log: ENOENT... mkdir '/var/
  // task/netlify/data'" - a Lambda's filesystem is read-only outside
  // /tmp, same reasoning utils/pdfRender.js/utils/familySchool.js's own
  // local-disk fallbacks already gate on LAMBDA_TASK_ROOT for. This file
  // exists purely so someone can open data/error.log after the fact on
  // a real local/LAN install (see this file's own header comment) -
  // there's no local disk to persist it to on Netlify at all, and every
  // caller already console.error()s the same error right before calling
  // this, which Netlify's own Function log already captures (exactly
  // how the real error above was found) - so this just no-ops there
  // instead of cluttering that same log with a second, confusing,
  // always-failing write attempt on top of the real error.
  if (process.env.LAMBDA_TASK_ROOT) return;
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
