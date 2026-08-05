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

// Shapes offered by the "Add Element" tool - value is what's stored on
// el.shapeType, label/icon drive the picker button.
const SHAPE_TYPES = [
  { value: 'rectangle', label: 'Rectangle', icon: '#icon-square' },
  { value: 'roundedRect', label: 'Rounded Rectangle', icon: '#icon-rounded-square' },
  { value: 'circle', label: 'Circle', icon: '#icon-circle' },
  { value: 'ellipse', label: 'Ellipse', icon: '#icon-ellipse' },
  { value: 'triangle', label: 'Triangle', icon: '#icon-triangle' },
  { value: 'diamond', label: 'Diamond', icon: '#icon-diamond' },
  { value: 'star', label: 'Star', icon: '#icon-star' },
  { value: 'arrow', label: 'Arrow', icon: '#icon-arrow-right' },
  { value: 'polygon', label: 'Polygon', icon: '#icon-hexagon' },
  { value: 'line', label: 'Line', icon: '#icon-line' },
];

// A handful of clean, print-friendly font choices. Open Sans, Montserrat
// and Lilita One are already loaded site-wide; the rest are safe system
// fonts every OS ships with.
const FONT_FAMILIES = [
  'Open Sans',
  'Montserrat',
  'Lilita One',
  'Arial',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
];

// Each template is { background, backgroundOpacity, elements: [...] }.
// Elements share a base shape of { id, type, x, y, width, height, rotation,
// opacity, locked } plus type-specific fields (text / shape / image /
// barcode). A text element's content is either a bound data field (e.g.
// "name") or, when field is 'custom', its own literal `text` string.
const DEFAULT_LAYOUTS = {
  student: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'org', type: 'text', field: 'custom', text: 'Sanford Homeschoolers', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 26, width: 320, height: 28, fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 56, width: 320, height: 20, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'allergies', type: 'text', field: 'allergies', x: 8, y: 78, width: 320, height: 40, fontSize: 11, color: '#dc2626', bold: true, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 145, width: 200, height: 55 },
    ],
  },
  parent: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'org', type: 'text', field: 'custom', text: 'Sanford Homeschoolers', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 28, width: 320, height: 30, fontSize: 19, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'team', type: 'text', field: 'cleanupTeam', x: 8, y: 60, width: 320, height: 36, fontSize: 12, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 145, width: 200, height: 55 },
    ],
  },
  admin: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'org', type: 'text', field: 'custom', text: 'Sanford Homeschoolers', x: 8, y: 6, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'name', type: 'text', field: 'name', x: 8, y: 58, width: 320, height: 52, fontSize: 22, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'barcode', type: 'barcode', x: 68, y: 145, width: 200, height: 55 },
    ],
  },
};

module.exports = { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS };
