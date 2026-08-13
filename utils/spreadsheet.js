const XLSX = require('xlsx');
const path = require('path');
const { Worker } = require('worker_threads');

// Builds an .xlsx file (as a Buffer) with a header row followed by a few
// example rows, so admins have a ready-made template for CSV/XLSX imports.
function buildTemplateWorkbook(headers, exampleRows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// The installed xlsx version (0.18.5, the last one SheetJS published to
// npm - newer fixes only ship from their own CDN now) has two known
// advisories in exactly this parse path: a prototype-pollution issue (a
// crafted header/cell name like "__proto__" can inject a key that, once
// merged onto a plain object, reaches up to Object.prototype and
// corrupts every object in the process) and a separate ReDoS. The
// prototype-pollution guard (dropping __proto__/constructor/prototype
// keys from every row) now lives in utils/spreadsheetWorker.js alongside
// the parse itself - see readRowsFromFile below for why the parse moved
// off this thread entirely, which is also what closes off the ReDoS: a
// hung worker gets terminated by the timeout instead of hanging the
// whole app.

const DEFAULT_PARSE_TIMEOUT_MS = 10 * 1000;

// Reads an uploaded .csv/.txt/.xlsx file into an array of row objects
// keyed by the header row. SheetJS auto-detects the format from the
// buffer. Runs in a separate worker thread with a hard wall-clock
// timeout rather than calling XLSX.read() directly on this (the main)
// thread - that parse is synchronous CPU-bound work, so a pathological
// file exploiting xlsx's unpatched ReDoS advisory would otherwise hang
// the entire single-threaded server, including live kiosk check-ins,
// for as long as it ran. Every call site already awaits/handles a
// rejection the same way it always handled a thrown parse error (see
// e.g. routes/admin-members.js's import route), so this only changes
// *how* a bad file fails, not what the caller does about it.
//
// timeoutMs is an optional override (tests use a tiny one to prove the
// termination path actually fires, rather than trusting it untested -
// no real caller needs anything but the default).
// __dirname is correct for a normal `node server.js` run, but esbuild
// bundles this file into the single netlify/functions/app.js output for
// the Netlify deployment - __dirname there resolves to that bundle's own
// directory, not this file's original location, and worker_threads' Worker
// loads spreadsheetWorker.js as a real file from disk (never `require()`d,
// so esbuild has no way to trace or bundle it at all), same class of
// problem as server.js's views/ path. LAMBDA_TASK_ROOT (set by the Lambda
// runtime Netlify Functions run on, never set for a normal local/LAN
// install) matches where netlify.toml's `included_files` actually copies
// utils/spreadsheetWorker.js to.
const WORKER_ROOT = process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, 'utils') : __dirname;

function readRowsFromFile(buffer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(WORKER_ROOT, 'spreadsheetWorker.js'));
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      worker.terminate();
      reject(new Error('That file took too long to read - it may be corrupted or too complex to import.'));
    }, timeoutMs || DEFAULT_PARSE_TIMEOUT_MS);

    worker.once('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve(msg.rows);
      else reject(new Error(msg.error));
    });

    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      reject(err);
    });

    worker.postMessage(buffer);
  });
}

// Quotes a CSV field and escapes embedded quotes. Every export route in
// the app builds its rows through this (rather than each hand-rolling
// `"${x.replace(/"/g, '""')}"` ) so a field never gets skipped by accident -
// that's exactly what happened to the Floater Assignments export before
// this existed, where two fields were pushed unquoted and a comma in a
// position/room value would silently shift the rest of the row.
function csvEscape(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function toCsvRow(fields) {
  return fields.map(csvEscape).join(',');
}

// Sends a CSV response with the header/body lines already built (see
// toCsvRow). Prepends a UTF-8 BOM so accented names open correctly in
// Excel instead of as mojibake.
const UTF8_BOM = '﻿';

function sendCsv(res, filename, lines) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(UTF8_BOM + lines.join('\n'));
}

module.exports = { buildTemplateWorkbook, readRowsFromFile, csvEscape, toCsvRow, sendCsv };
