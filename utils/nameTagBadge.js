// Shared badge layout constants and defaults, used by the design editor,
// the seed data, and every render path (single preview/print, bulk print).
// Deliberately has no dependency on ../db - db/index.js requires this
// module during its own startup (to seed default templates), so pulling
// in ../db here would create a require cycle. DB-backed lookups (the
// current saved template, per-member badge data) live in nameTagData.js.

// 3.5in x 2.25in (landscape) at 96dpi - CSS px are defined as 1/96in, so
// these numbers double as both on-screen editor pixels and true print
// dimensions.
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
  admin: [{ field: 'name', label: 'Name' }],
};

const DEFAULT_LAYOUTS = {
  student: [
    { id: 'name', type: 'text', field: 'name', x: 8, y: 10, width: 320, height: 30, fontSize: 19, color: '#1c2530', bold: true, align: 'center' },
    { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 42, width: 320, height: 22, fontSize: 13, color: '#1c2530', bold: false, align: 'center' },
    { id: 'allergies', type: 'text', field: 'allergies', x: 8, y: 66, width: 320, height: 42, fontSize: 12, color: '#dc2626', bold: true, align: 'center' },
    { id: 'barcode', type: 'barcode', x: 68, y: 145, width: 200, height: 55 },
  ],
  parent: [
    { id: 'name', type: 'text', field: 'name', x: 8, y: 16, width: 320, height: 34, fontSize: 21, color: '#1c2530', bold: true, align: 'center' },
    { id: 'team', type: 'text', field: 'cleanupTeam', x: 8, y: 54, width: 320, height: 40, fontSize: 13, color: '#1c2530', bold: false, align: 'center' },
    { id: 'barcode', type: 'barcode', x: 68, y: 145, width: 200, height: 55 },
  ],
  admin: [
    { id: 'name', type: 'text', field: 'name', x: 8, y: 70, width: 320, height: 38, fontSize: 21, color: '#1c2530', bold: true, align: 'center' },
    { id: 'barcode', type: 'barcode', x: 68, y: 145, width: 200, height: 55 },
  ],
};

module.exports = { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, DEFAULT_LAYOUTS };
