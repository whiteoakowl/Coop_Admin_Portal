// Shared Schedule Card layout constants and defaults - the Schedule Card
// equivalent of utils/nameTagBadge.js. Same physical dimensions and
// element shape as a name tag (see that file for the element format), so
// shapes/fonts are reused directly rather than redefined.
const { SHAPE_TYPES, FONT_FAMILIES } = require('./nameTagBadge');

// 3.5in x 2.25in (landscape) at 96dpi - same card stock size as a name tag.
const CARD_WIDTH = 336;
const CARD_HEIGHT = 216;

// Fields available to place on the card. The two schedule fields are
// tables (exactly 4 rows), not plain text - see FONT_FAMILIES usage in
// the editor for how a table element's properties differ from a text
// element's.
const FIELDS = [
  { field: 'name', label: 'Member Name' },
  { field: 'allergy', label: 'Allergy' },
  { field: 'primaryParentPhone', label: 'Primary Parent Phone' },
];
const TABLE_FIELDS = [
  { field: 'mondaySchedule', label: 'Monday Schedule', day: 'monday' },
  { field: 'wednesdaySchedule', label: 'Wednesday Schedule', day: 'wednesday' },
];

// One shared layout for every member - the member's allergy (if any) top
// left in red, matching how the name tag's own Allergies field is styled,
// with the family's primary parent phone on the same line at the right,
// then both day tables stacked one above the other (full card width each)
// rather than side by side. Freeing that second row gives both tables
// more height to work with, so a full 4-row table has real room instead
// of being squeezed - see tableColumnWidths in name-tag-render-core.js
// for how each table's own column widths adapt to fit their content
// within that fixed box. The card's own size (CARD_WIDTH/CARD_HEIGHT)
// never changes.
const DEFAULT_LAYOUT = {
  background: '#ffffff',
  backgroundOpacity: 1,
  elements: [
    { id: 'allergy', type: 'text', field: 'allergy', x: 8, y: 5, width: 210, height: 14, fontSize: 11, color: '#dc2626', bold: true, align: 'left', valign: 'middle', autoFitText: true },
    { id: 'parent-phone', type: 'text', field: 'primaryParentPhone', x: 222, y: 5, width: 106, height: 14, fontSize: 8, color: '#5b6b7c', bold: false, align: 'right', valign: 'middle', autoFitText: true },
    { id: 'mon-label', type: 'text', field: 'custom', text: 'Monday', x: 8, y: 21, width: 320, height: 11, fontSize: 9, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
    { id: 'mon-table', type: 'table', field: 'mondaySchedule', x: 8, y: 33, width: 320, height: 82, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
    { id: 'wed-label', type: 'text', field: 'custom', text: 'Wednesday', x: 8, y: 117, width: 320, height: 11, fontSize: 9, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
    { id: 'wed-table', type: 'table', field: 'wednesdaySchedule', x: 8, y: 129, width: 320, height: 79, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
  ],
};

module.exports = { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUT };
