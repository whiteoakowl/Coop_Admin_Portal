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
const FIELDS = [{ field: 'name', label: 'Member Name' }];
const TABLE_FIELDS = [
  { field: 'mondaySchedule', label: 'Monday Schedule', day: 'monday' },
  { field: 'wednesdaySchedule', label: 'Wednesday Schedule', day: 'wednesday' },
];

// One shared layout for every member - a title, the member's name, and
// both day tables stacked side by side.
const DEFAULT_LAYOUT = {
  background: '#ffffff',
  backgroundOpacity: 1,
  elements: [
    { id: 'org', type: 'text', field: 'custom', text: 'Sanford Homeschoolers', x: 8, y: 6, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
    { id: 'name', type: 'text', field: 'name', x: 8, y: 22, width: 320, height: 26, fontSize: 16, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
    { id: 'mon-label', type: 'text', field: 'custom', text: 'Monday', x: 8, y: 50, width: 154, height: 14, fontSize: 10, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
    { id: 'wed-label', type: 'text', field: 'custom', text: 'Wednesday', x: 174, y: 50, width: 154, height: 14, fontSize: 10, color: '#2e6da4', bold: true, align: 'center', valign: 'middle' },
    { id: 'mon-table', type: 'table', field: 'mondaySchedule', x: 8, y: 65, width: 154, height: 145, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
    { id: 'wed-table', type: 'table', field: 'wednesdaySchedule', x: 174, y: 65, width: 154, height: 145, fontSize: 8, borderColor: '#dbe8f5', headerColor: '#eaf4fd' },
  ],
};

module.exports = { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUT };
