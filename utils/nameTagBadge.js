// Shared badge layout constants and defaults, used by the design editor,
// the seed data, and every render path (single preview/print, bulk print).
// Deliberately has no dependency on ../db - db/index.js requires this
// module during its own startup (to seed default templates), so pulling
// in ../db here would create a require cycle. DB-backed lookups (the
// current saved template, per-member badge data) live in nameTagData.js.

// 3.5in x 2.25in at 96dpi - CSS px are defined as 1/96in, so these numbers
// double as both on-screen editor pixels and true print dimensions.
const BADGE_WIDTH = 336;
const BADGE_HEIGHT = 216;

// Fields available to place on each badge type's canvas.
const FIELDS_BY_TYPE = {
  student: [
    { field: 'name', label: 'Name' },
    { field: 'gradeLevel', label: 'Grade Level' },
    { field: 'allergies', label: 'Allergies' },
  ],
  parent: [
    { field: 'name', label: 'Name' },
    { field: 'cleanupTeam', label: 'Cleanup Team' },
  ],
};

const DEFAULT_LAYOUTS = {
  student: [
    { id: 'name', type: 'text', field: 'name', x: 10, y: 10, width: 316, height: 32, fontSize: 20, color: '#1c2530', bold: true, align: 'center' },
    { id: 'grade', type: 'text', field: 'gradeLevel', x: 10, y: 46, width: 316, height: 24, fontSize: 14, color: '#1c2530', bold: false, align: 'center' },
    { id: 'allergies', type: 'text', field: 'allergies', x: 10, y: 74, width: 316, height: 44, fontSize: 12, color: '#dc2626', bold: true, align: 'center' },
    { id: 'barcode', type: 'barcode', x: 43, y: 150, width: 250, height: 55 },
  ],
  parent: [
    { id: 'name', type: 'text', field: 'name', x: 10, y: 20, width: 316, height: 34, fontSize: 22, color: '#1c2530', bold: true, align: 'center' },
    { id: 'team', type: 'text', field: 'cleanupTeam', x: 10, y: 60, width: 316, height: 26, fontSize: 14, color: '#1c2530', bold: false, align: 'center' },
    { id: 'barcode', type: 'barcode', x: 43, y: 150, width: 250, height: 55 },
  ],
};

module.exports = { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, DEFAULT_LAYOUTS };
