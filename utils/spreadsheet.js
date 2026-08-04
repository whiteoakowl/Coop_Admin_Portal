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

module.exports = { buildTemplateWorkbook, readRowsFromFile };
