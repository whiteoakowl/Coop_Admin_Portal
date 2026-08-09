const XLSX = require('xlsx');

// Builds an .xlsx file (as a Buffer) with a header row followed by a few
// example rows, so admins have a ready-made template for CSV/XLSX imports.
function buildTemplateWorkbook(headers, exampleRows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Reads an uploaded .csv/.txt/.xlsx file into an array of row objects keyed
// by the header row. SheetJS auto-detects the format from the buffer.
function readRowsFromFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
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
