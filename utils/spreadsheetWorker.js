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
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }).map(sanitizeRow) : [];
    parentPort.postMessage({ ok: true, rows });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message || 'Could not read that file.' });
  }
});
