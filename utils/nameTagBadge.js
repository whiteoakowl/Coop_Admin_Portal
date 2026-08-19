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

// Fields available to place on each badge type's canvas. student/parent
// are per-member name tags; setupCleanup/custom are the two non-member
// "misc badge" types (see misc_badge_templates/misc_badges in schema.sql
// and utils/miscBadgeData.js) - each row of an admin-imported list, not a
// member, so they share a plain Badge Number/Title/Description shape
// instead of member fields.
const FIELDS_BY_TYPE = {
  student: [
    { field: 'name', label: 'Name' },
    { field: 'gradeLevel', label: 'Grade Level' },
    { field: 'allergies', label: 'Allergies' },
    { field: 'memberCode', label: 'Member ID' },
  ],
  parent: [
    { field: 'name', label: 'Name' },
    // One shared field/element for both days (utils/nameTagData.js's
    // setupCleanupJobLabels hands back the two lines as an array) - a
    // real request: Monday's and Wednesday's jobs should "share a text
    // space" instead of being two separately-positioned elements. The old
    // mondaySetupCleanup/wednesdaySetupCleanup fields still render fine
    // (badgeDataForMember/badgeDataForMembers still populate them) for any
    // already-saved layout that references them directly, but aren't
    // offered here anymore so a fresh "Add Element" always gets the
    // shared shape.
    { field: 'setupCleanupDays', label: 'Monday & Wednesday Setup/Cleanup Jobs' },
    // cleanupTeam (the old "both days smashed into one comma list, no day
    // label" field) is deliberately NOT offered here anymore - a real bug
    // report: an admin had re-added it via this picker at some point, at
    // a position that ended up overlapping other elements once the badge
    // was redesigned around setupCleanupDays above, showing garbled
    // fragments of team text on the printed badge (invisible in the
    // editor's own preview when a later, fully-opaque element happened to
    // paint over it there). See db/bootstrapPg.js's
    // backfillParentRemoveLegacyCleanupTeamElement, which now strips any
    // cleanupTeam element unconditionally - setupCleanupDays already
    // covers everything cleanupTeam did, day-by-day instead of smashed
    // together, so there's no remaining reason to offer it here.
    { field: 'memberCode', label: 'Member ID' },
  ],
  // A real request: "an admin name tag... logo, name, barcode, id number
  // and the admin position" - co-op staff/leaders (member_type === 'admin',
  // see members.member_type's own schema comment). adminPosition is the
  // Settings-managed admin_positions list title (utils/adminPositions.js),
  // optionally chosen on the member form.
  admin: [
    { field: 'name', label: 'Name' },
    { field: 'adminPosition', label: 'Admin Position' },
    { field: 'memberCode', label: 'Member ID' },
  ],
  // A real bug report: "Setup/cleanup task cards are a mess... The only
  // information that should be included on each setup/cleanup badge is
  // day, team name, leader, task and the barcode" - badgeNumber (the old
  // big scannable digits at top, redundant with the barcode itself) and
  // the generic "Title"/"Description" labels are gone; title/description
  // still bind to the same misc_badges columns, just repurposed (see
  // utils/taskList.js's upsertTaskBadge) to actually mean Team Name/Task
  // now, and day/leaderLabel are genuinely new fields.
  setupCleanup: [
    { field: 'day', label: 'Day' },
    { field: 'title', label: 'Team Name' },
    { field: 'leaderLabel', label: 'Leader' },
    { field: 'description', label: 'Task' },
  ],
  custom: [
    { field: 'badgeNumber', label: 'Badge Number' },
    { field: 'title', label: 'Title' },
    { field: 'description', label: 'Description' },
  ],
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
      { id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 148, y: 4, width: 40, height: 40 },
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 50, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      // A real request: first name stacked over last name (utils/
      // nameTagData.js's splitNameLines hands back the two lines as an
      // array - same convention setupCleanupDays/gradeLevel below use)
      // instead of one "First Last" line, so each half has real room to
      // run a bigger font than a single line sharing this same 320px
      // width ever could. The box is taller than a single-line name field
      // used to need for the same reason - see public/js/badge-autofit.js's
      // shrinkLinesToFitHeight for what keeps a longer two-line name from
      // ever clipping even on an already-saved template that hasn't
      // picked up this taller box (a backfill only ever ADDS height, see
      // db/bootstrapPg.js's backfillNameTagStackedSizing, but the real
      // guarantee against clipping is that height-aware correction, not
      // the box size itself).
      { id: 'name', type: 'text', field: 'name', x: 8, y: 68, width: 320, height: 40, fontSize: 22, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      // A real bug report: a longer grade_level value ("Kindergarten",
      // once badgeDataForMember started appending "Grade" to the ordinal
      // ones too - see utils/nameTagData.js's gradeLevelLabel) could clip
      // the same way an unshrunk long name used to - same autoFitText
      // treatment as name above. A follow-up request then asked for the
      // ordinal grades to stack ("3rd" over "Grade" - gradeLevelLabel
      // returns that as a 2-line array too) rather than sit on one line,
      // for the same "more room for a bigger font" reason as name above.
      { id: 'grade', type: 'text', field: 'gradeLevel', x: 8, y: 110, width: 320, height: 36, fontSize: 16, color: '#1c2530', bold: false, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'barcode', type: 'barcode', x: 68, y: 154, width: 200, height: 55 },
    ],
  },
  parent: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      // A real request: a parent's own Monday/Wednesday setup/cleanup job
      // (which team they're on that specific day, not the old combined
      // "both days smashed into one line" cleanupTeam field below) needs
      // to be the first thing on the badge - front-and-center, above even
      // the logo/name, so it's the first thing anyone (the parent
      // themselves, or whoever's checking) sees. Both days now share ONE
      // element/text space (setupCleanupDays - utils/nameTagData.js's
      // setupCleanupJobLabels hands back the two pre-labeled lines,
      // "Monday - Chairs & Tables" / "Wednesday - —", as an array) instead
      // of two separately-positioned elements - name-tag-render-core.js's
      // renderTextEl stacks an array field's lines top-to-bottom within
      // the one box, each still individually labeled and individually
      // shrunk to fit (see public/js/badge-autofit.js's shrinkToFit).
      { id: 'setup-cleanup-days', type: 'text', field: 'setupCleanupDays', x: 8, y: 4, width: 320, height: 32, fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle', autoFitText: true },
      { id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 152, y: 38, width: 32, height: 32 },
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 74, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      // Same first-name-over-last-name stacking as the student badge
      // above (utils/nameTagData.js's splitNameLines) - see that
      // element's own comment.
      { id: 'name', type: 'text', field: 'name', x: 8, y: 90, width: 320, height: 40, fontSize: 20, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'barcode', type: 'barcode', x: 68, y: 156, width: 200, height: 55 },
    ],
  },
  admin: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 148, y: 4, width: 40, height: 40 },
      { id: 'memberCode', type: 'text', field: 'memberCode', x: 8, y: 50, width: 320, height: 18, fontSize: 12, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      // Same first-name-over-last-name stacking as the student/parent
      // badges above (utils/nameTagData.js's splitNameLines) - see the
      // student badge's own comment for why.
      { id: 'name', type: 'text', field: 'name', x: 8, y: 68, width: 320, height: 40, fontSize: 22, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      // A real bug report, live screenshot: a longer single position
      // ("Community Service Coordinator", "Parent Support Coordinator")
      // wrapped onto 2-3 lines and got clipped at the box's own top edge -
      // autoFitText alone forces a field onto ONE line (nowrap + shrink,
      // see name-tag-render-core.js's renderTextEl), which is right for
      // Name but wrong here: "the admin positions should never be more
      // than two stacked text lines" is an explicit request for real wrap,
      // not an ever-shrinking single line. autoFitWrap opts this field
      // into that different mode - real CSS wrap plus real-browser
      // height-correction (public/js/badge-autofit.js), the same
      // mechanism already proven for 2+ actual stacked positions, just
      // now also covering ONE long position's own internal wrap. Height
      // bumped a little (36 -> 40) so a typical 2-line wrap fits at close
      // to its full configured font size instead of needing to shrink
      // right away.
      { id: 'position', type: 'text', field: 'adminPosition', x: 8, y: 110, width: 320, height: 40, fontSize: 16, color: '#1c2530', bold: false, align: 'center', valign: 'middle', autoFitText: true, autoFitWrap: true },
      { id: 'barcode', type: 'barcode', x: 68, y: 154, width: 200, height: 55 },
    ],
  },
  // A real bug report: "Setup/cleanup task cards are a mess... Make sure
  // text/font fit the spaces. The only information that should be
  // included on each setup/cleanup badge is day, team name, leader, task
  // and the barcode." Root cause of the old mess: none of these elements
  // had autoFitText, so a long task description (or team name) just
  // overflowed its fixed box and visibly overlapped the line below it -
  // every text element here gets the same shrink-to-fit treatment the
  // student/parent/admin name tags already use for their own
  // longest-running fields (see public/js/badge-autofit.js). Task gets
  // the tallest box since it's reliably the longest-running text.
  //
  // A real follow-up request: the task/description field specifically
  // should NOT shrink its font to stay on one line - "do not reduce the
  // font size to keep it all on one line. keep the same font size and
  // simply continue the tasks description on the next line below it."
  // autoFitText is dropped just for this one element (day/team/leader
  // keep it - short single-line fields still benefit from never
  // overlapping the line below) - renderTextEl (public/js/name-tag-
  // render-core.js) only forces the single-line nowrap+shrink treatment
  // when autoFitText is set, so without it this falls back to plain
  // overflow-wrap: break-word at its own fixed 14px, wrapping across
  // however many lines it needs within its own already-generous 78px-tall
  // box (deliberately sized as the tallest field here for exactly this
  // kind of longer text) instead of shrinking to fit one line.
  setupCleanup: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'day', type: 'text', field: 'day', x: 8, y: 6, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: true, align: 'center', valign: 'middle' },
      { id: 'team', type: 'text', field: 'title', x: 8, y: 24, width: 320, height: 32, fontSize: 17, color: '#1c2530', bold: true, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'leader', type: 'text', field: 'leaderLabel', x: 8, y: 58, width: 320, height: 16, fontSize: 11, color: '#5b6b7c', bold: false, align: 'center', valign: 'middle', autoFitText: true },
      { id: 'task', type: 'text', field: 'description', x: 8, y: 76, width: 320, height: 78, fontSize: 14, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
      // barcodeValue is this task's own code (misc_badges.barcode, set by
      // utils/taskList.js's upsertTaskBadge) - lets a parent scan the
      // physical badge at checkout to confirm which task they completed
      // (see routes/checkout.js's new step 2).
      { id: 'barcode', type: 'barcode', x: 68, y: 156, width: 200, height: 55 },
    ],
  },
  custom: {
    background: '#ffffff',
    backgroundOpacity: 1,
    elements: [
      { id: 'title', type: 'text', field: 'title', x: 8, y: 20, width: 320, height: 32, fontSize: 20, color: '#1c2530', bold: true, align: 'center', valign: 'middle' },
      { id: 'description', type: 'text', field: 'description', x: 8, y: 60, width: 320, height: 140, fontSize: 13, color: '#1c2530', bold: false, align: 'center', valign: 'middle' },
    ],
  },
};

module.exports = { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS };
