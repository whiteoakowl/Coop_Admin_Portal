const XLSX = require('xlsx');

// Builds an .xlsx file (as a Buffer) with a header row followed by a few
// example rows, so admins have a ready-made template for CSV/XLSX imports.
function buildTemplateWorkbook(headers, exampleRows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// The installed xlsx version (0.18.5, the last one SheetJS published to
// npm - newer fixes only ship from their own CDN now) has a known
// prototype-pollution advisory in exactly this parse path: a crafted
// header/cell name like "__proto__" can inject a key that, once merged
// onto a plain object, reaches up to Object.prototype and corrupts every
// object in the process, not just this one row. Rebuilding each row as a
// fresh plain object and dropping any such key closes that off at the
// one place every import route in the app funnels through, independent
// of whether/when the underlying library gets a real fix. A legitimate
// import file has no business having a column literally named
// "__proto__" anyway, so this can't reject anything genuine.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizeRow(row) {
  const clean = {};
  for (const key of Object.keys(row)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = row[key];
  }
  return clean;
}

// Reads an uploaded .csv/.txt/.xlsx file into an array of row objects keyed
// by the header row. SheetJS auto-detects the format from the buffer.
function readRowsFromFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' }).map(sanitizeRow);
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
