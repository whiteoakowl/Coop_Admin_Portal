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
  { field: 'primaryParentPhone', label: 'Primary Parent Phone' },
];
const TABLE_FIELDS = [
  { field: 'mondaySchedule', label: 'Monday Schedule', day: 'monday' },
  { field: 'wednesdaySchedule', label: 'Wednesday Schedule', day: 'wednesday' },
];

// One shared layout for every member - the member's name, a "Parent
// Phone:" line underneath (the family's primary parent - see
// scheduleCardDataForMember), then both day tables stacked one above the
// other (full card width each) rather than side by side.
const DEFAULT_LAYOUT = {
  background: '#ffffff',
  backgroundOpacity: 1,
  elements: [
    { id: 'name', type: 'text', field: 'name', x: 8, y: 5, width: 320, height: 14, fontSize: 12, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
    { id: 'parent-phone', type: 'text', field: 'primaryParentPhone', x: 8, y: 20, width: 320, height: 11, fontSize: 8, color: '#5b6b7c', bold: false, align: 'center', valign: 'middle' },
    { id: 'mon-label', type: 'text', field: 'custom', text: 'Monday', x: 8, y: 33, width: 320, height: 11, fontSize: 9, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
    { id: 'mon-table', type: 'table', field: 'mondaySchedule', x: 8, y: 45, width: 320, height: 66, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
    { id: 'wed-label', type: 'text', field: 'custom', text: 'Wednesday', x: 8, y: 113, width: 320, height: 11, fontSize: 9, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
    { id: 'wed-table', type: 'table', field: 'wednesdaySchedule', x: 8, y: 125, width: 320, height: 68, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
  ],
};

module.exports = { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUT };
