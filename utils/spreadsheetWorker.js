// Runs the actual XLSX.read()/sheet_to_json() work for utils/spreadsheet.js's
// readRowsFromFile, in a separate worker thread rather than the main one.
// This is CPU-bound, synchronous work - a crafted file exploiting the
// installed xlsx version's still-unpatched ReDoS advisory (GHSA-5pgg-2g8v-p4x9,
// see utils/spreadsheet.js's own comment on the sibling prototype-pollution
// fix) would hang whichever thread runs it indefinitely, and nothing on
// that same thread - a setTimeout included - can ever preempt already-
// running synchronous JS to stop it. Isolating the parse here means the
// caller can enforce a hard wall-clock timeout by terminating this whole
// worker from the outside, which is the only thing that actually works.
const { parentPort } = require('worker_threads');
const XLSX = require('xlsx');

// Same guard as the prototype-pollution mitigation this duplicates from
// utils/spreadsheet.js (kept self-contained here rather than required
// across the worker boundary, so this file has no dependency on anything
// but xlsx itself).
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizeRow(row) {
  const clean = {};
  for (const key of Object.keys(row)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = row[key];
  }
  return clean;
}

parentPort.once('message', (buffer) => {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw: false - use each cell's FORMATTED display text (SheetJS's `w`
    // property, honoring the cell's own number format) instead of its raw
    // underlying value (`v`, the default). Without this, a genuine Excel/
    // Google Sheets Time or Date cell - which is what typing "10:00 AM" or
    // a birthdate into a spreadsheet actually produces, not a plain text
    // string - comes back as a raw numeric day-fraction/serial (e.g.
    // 0.4166666666666667 for "10:00 AM") instead of "10:00 AM". Every
    // downstream consumer of an imported row (parseClockMinutes here,
    // Date.parse-shaped birthday parsing elsewhere, the Student/Parent
    // Schedule import's own start-time class-matching) expects that
    // human-readable text, not the raw serial - a real bug report: a
    // spreadsheet's later class slots (whichever cells Excel had
    // auto-formatted as Time, not necessarily all of them) were silently
    // failing routes/admin-schedule.js's scheduleFieldMismatch time check
    // against the class's own cleanly-stored start_time, so those
    // enrollments were dropped entirely on import - no error, just a
    // quietly higher "skipped" count in the import notice - which then
    // showed up as a too-short Arrival/Departure window on the Attendance
    // roster (correctly computed from the member's now-incomplete real
    // enrollment data, but wrong relative to their actual intended
    // schedule). A plain string/CSV cell already has no separate raw-vs-
    // formatted distinction, so this is a no-op for every import that
    // doesn't touch a numeric/date/time-typed cell.
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }).map(sanitizeRow) : [];
    parentPort.postMessage({ ok: true, rows });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message || 'Could not read that file.' });
  }
});
