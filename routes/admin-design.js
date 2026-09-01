const express = require('express');
const router = express.Router();
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES: CARD_SHAPE_TYPES, FONT_FAMILIES: CARD_FONT_FAMILIES, DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');
const { getScheduleCardTemplate } = require('../utils/scheduleCardData');
const { getMiscTemplate, listMiscBadges } = require('../utils/miscBadgeData');
const { jsonScriptSafe } = require('../utils/json');
const { membersWithDetails, byLastName } = require('../utils/members');
const { buildDuplexPages, SCHEDULE_CARD_SAFE_INSET } = require('../utils/duplexPrint');
const { buildCardPairs } = require('../utils/cardPairs');
const { formatDateLabel, formatTimestamp } = require('../utils/dates');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { allClassesList, UNASSIGNED_ROOM, HOUR_POSITIONS } = require('../utils/classSchedule');
const { DAYS, DAY_LABELS } = require('../utils/days');
const { playgroundHourLabel } = require('../utils/playground');
const { allItems: allLibraryItems, allLibraryTypes } = require('../utils/library');

router.use(requireFullAdmin);

const DESIGN_TYPES = ['student', 'parent', 'admin', 'scheduleCard', 'setupCleanup', 'custom'];
const TABS = ['design', 'print', 'requests'];

const REQUEST_TYPE_LABELS = { new_tag: 'New Name Tag', lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const NAME_TAG_DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday', both: 'Both' };

// Name Tag Requests: every public Name Tag Request form submission (lost
// tag / schedule change) - also surfaced here on its own Requests tab
// alongside Design and Print, since a request usually means printing a
// new name tag, not just reviewing an activity record. This duplicates
// routes/admin-logs.js's own nameTagSubmissions/REQUEST_TYPE_LABELS/
// NAME_TAG_DAY_LABELS and export/archive/unarchive routes deliberately -
// the Logs tab (/admin/logs?tab=nametag) keeps working exactly as before,
// this is a second, independent way to reach the same underlying
// name_tag_requests data, not a replacement for it.
async function nameTagSubmissions(showArchived, dateFilter) {
  let sql = `SELECT n.id AS id, n.member_id AS "memberId", m.name AS "memberName", n.request_type AS "requestType", n.day AS day,
             n.description AS description, n.created_at AS "createdAt"
             FROM name_tag_requests n
             JOIN members m ON m.id = n.member_id
             WHERE n.archived = ?`;
  const params = [showArchived ? 1 : 0];
  if (dateFilter) {
    sql += ' AND date(n.created_at) = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY n.created_at DESC';

  return db.prepare(sql).all(...params);
}

// Unified Design/Print page: Design has one dropdown (Student/Parent/Admin
// Name Tag, or Schedule Card) instead of separate Name Tag and Schedule
// Card design pages. Both canvas editors render into the same page and
// toggle with plain show/hide - each keeps its own untouched engine
// (name-tag-editor.js / schedule-card-editor.js), so switching types never
// reloads the page. Print has a dropdown of what to print (schedule cards,
// name tags, schedules, logs), reusing the existing print flows for each.
router.get('/design', async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'design';
  const initialType = DESIGN_TYPES.includes(req.query.type) ? req.query.type : 'student';

  // Same photo/type/family/rosters shape as the Members page's own table -
  // the Print tab's bulk picker lists are meant to look and read like that
  // list (just with a selection checkbox instead of Actions), not a bare
  // name-only table.
  const members = (await membersWithDetails()).filter((m) => m.active);

  // Class Check-In QR Codes picker (Print tab) - every class across both
  // days, sorted the same way the Attendance page's own Class Rosters
  // list is (allClassesList's own ORDER BY), so the picker reads in a
  // predictable, alphabetical order rather than day-then-hour.
  const classesForQr = await allClassesList();
  // Distinct room values across those classes, for the Filter popup's Room
  // dropdown - a real request: "Class QR code printing filter should be
  // filter by day and room number, remove hour filter." Room is free text
  // (unlike hour_position's fixed 1-4), so the dropdown's own options are
  // whatever rooms are actually in use rather than a hardcoded list.
  const qrRoomOptions = [...new Set(classesForQr.map((c) => c.room).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

  // Requests tab data - only meaningful when tab === 'requests', but
  // computed unconditionally (same eager-compute style as members/badges
  // above) rather than branching the render call in two.
  const dateFilter = req.query.date || '';
  const showArchived = req.query.archived === '1';
  const allSubmissions = (await nameTagSubmissions(showArchived, dateFilter)).map((r) => ({
    id: r.id,
    timestamp: formatTimestamp(r.createdAt),
    memberName: r.memberName,
    requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
    dayLabel: NAME_TAG_DAY_LABELS[r.day] || r.day,
    description: r.description || '—',
  }));
  const requestDates = (
    await db
      .prepare(`SELECT DISTINCT date(created_at)::text AS d FROM name_tag_requests WHERE archived = ? ORDER BY d DESC`)
      .all(showArchived ? 1 : 0)
  ).map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));
  const requestsPageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const requestsPagination = paginate(allSubmissions, parsePage(req.query.page), requestsPageSize);

  // Print tab's own "Name Tag Requests" option - a real request: "add a
  // dropdown choice called name tag requests. when you choose this
  // option it will show the names of the people currently on the
  // nametag request log that need to be printed." Always the full,
  // unarchived request log regardless of the Requests tab's own
  // date/archived filters above (this is a "what still needs printing
  // right now" picker, not another view of that tab). One row per
  // member, not per request - a member with more than one open request
  // (e.g. both a Lost Tag and a Schedule Change) would otherwise get two
  // duplicate checkboxes for the same person.
  const pendingByMember = new Map();
  for (const r of await nameTagSubmissions(false, '')) {
    const label = REQUEST_TYPE_LABELS[r.requestType] || r.requestType;
    if (!pendingByMember.has(r.memberId)) pendingByMember.set(r.memberId, { memberId: r.memberId, memberName: r.memberName, requestLabels: [] });
    pendingByMember.get(r.memberId).requestLabels.push(label);
  }
  const pendingNameTagRequests = [...pendingByMember.values()]
    .map((p) => ({ memberId: p.memberId, memberName: p.memberName, requestSummary: p.requestLabels.join(', ') }))
    .sort((a, b) => a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' }));

  res.render('admin-design', {
    title: 'Design / Print',
    tab,
    initialType,
    members,
    classesForQr,
    qrRoomOptions,
    libraryItems: await allLibraryItems(),
    libraryTypes: await allLibraryTypes(),
    error: req.query.error || null,
    initialPrintPanel: ['setupCleanupBadges', 'customBadges'].includes(req.query.print) ? req.query.print : null,
    notice: req.query.notice || null,
    setupCleanupBadges: await listMiscBadges('setupCleanup'),
    customBadges: await listMiscBadges('custom'),
    pendingNameTagRequests,
    submissions: requestsPagination.items,
    allSubmissions,
    pagination: requestsPagination,
    viewingAll: requestsPageSize === Infinity,
    baseHref: `/admin/design?tab=requests${showArchived ? '&archived=1' : ''}${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
    dates: requestDates,
    dateFilter,
    showArchived,
    nameTagDataJson: jsonScriptSafe({
      templates: {
        student: await getTemplate('student'),
        parent: await getTemplate('parent'),
        admin: await getTemplate('admin'),
        setupCleanup: await getMiscTemplate('setupCleanup'),
        custom: await getMiscTemplate('custom'),
      },
      defaultLayouts: DEFAULT_LAYOUTS,
      fieldsByType: FIELDS_BY_TYPE,
      shapeTypes: SHAPE_TYPES,
      fontFamilies: FONT_FAMILIES,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
    }),
    scheduleCardDataJson: jsonScriptSafe({
      template: await getScheduleCardTemplate(),
      defaultLayout: DEFAULT_LAYOUT,
      fields: FIELDS,
      tableFields: TABLE_FIELDS,
      shapeTypes: CARD_SHAPE_TYPES,
      fontFamilies: CARD_FONT_FAMILIES,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
    }),
  });
});

router.get('/design/requests/export.csv', async (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const submissions = await nameTagSubmissions(showArchived, dateFilter);
  const lines = [
    toCsvRow(['Submitted', 'Name', 'Request', 'Day', 'Description']),
    ...submissions.map((r) =>
      toCsvRow([
        formatTimestamp(r.createdAt),
        r.memberName,
        REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
        NAME_TAG_DAY_LABELS[r.day] || r.day,
        r.description || '',
      ])
    ),
  ];
  sendCsv(res, `name-tag-${showArchived ? 'archived' : 'requests'}.csv`, lines);
});

router.post('/design/requests/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE name_tag_requests SET archived = 1 WHERE id = ?').run(id);
  res.redirect('/admin/design?tab=requests');
});

router.post('/design/requests/:id/unarchive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE name_tag_requests SET archived = 0 WHERE id = ?').run(id);
  res.redirect('/admin/design?tab=requests&archived=1');
});

// Bulk "Name Tags + Schedule Cards" print: each selected member's two
// cards side by side, one row per member - unlike the separate bulk Name
// Tag / Schedule Card sheets (8-per-page grids of one card type), this is
// a comparison/cut-together layout, so it isn't pinned to that grid.
router.post('/design/print-both', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  res.render('admin-name-tag-both-print', {
    title: 'Print Name Tags + Schedule Cards',
    pairs: await buildCardPairs(members),
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    SCHEDULE_CARD_SAFE_INSET,
  });
});

// Bulk "Name Tags + Schedule Cards, Front & Back" print: name tags fill
// the front of each sheet, the matching schedule cards fill the back
// (see utils/duplexPrint.js), so printing double-sided and cutting along
// the grid lines gives each member a single two-sided card instead of
// two separate ones.
router.post('/design/print-duplex', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  const { frontPages, backPages } = buildDuplexPages(await buildCardPairs(members));

  res.render('admin-cards-duplex-print', {
    title: 'Print Name Tags + Schedule Cards (Front & Back)',
    frontPages,
    backPages,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    SCHEDULE_CARD_SAFE_INSET,
  });
});

// Class Check-In QR Codes: a real request - "add printing QR sheets to
// scan for quick links to class check in/out kiosk for teachers." Each
// selected class gets one QR code encoding an ABSOLUTE URL to that
// class's own Class Check-In quick link (the same /kiosk/class-checkin/
// classes/:id/attendance page every class card's own quick link opens -
// see views/partials/class-schedule-grid.ejs) - absolute, unlike every
// other link this app hands out, because a QR code is scanned by a
// phone's camera with no browsing context of its own to resolve a
// relative path against, unlike every other "opens in a new tab" link
// here that's always clicked from inside this same site.
//
// A real follow-up request: "Each page should be all of the class qr
// codes for that classroom, that day... Each page should have 4 equal
// spots." Used to just chunk the selection 4-at-a-time in whatever order
// allClassesList's own alphabetical sort put them in, mixing rooms/days
// freely across a page and reading in an order with no relation to
// either. Grouped by (day, room) instead, one page per combination, each
// page's classes sorted by hour_position - db/schema.sql's own CHECK
// constraint caps hour_position at 1-4, so a single room can never need
// more than 4 slots on a given day, meaning every group already fits on
// one page with no further chunking needed. .qr-sheet-grid's fixed 2x2
// CSS grid (styles.css) already reserves the full 4-cell layout no
// matter how many of a page's up-to-4 classes actually exist - a room
// that only teaches 2 classes that day still gets the same evenly-spaced
// 2x2 page shape, just with 2 of the 4 grid cells left empty, rather than
// stretching to fill the space.
router.post('/design/print-classcheckin-qr', async (req, res) => {
  const classIds = [].concat(req.body.classIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (classIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one class to print.'));
  }

  const allClasses = await allClassesList();
  const idSet = new Set(classIds);
  const classes = allClasses.filter((c) => idSet.has(c.id));

  const origin = `${req.protocol}://${req.get('host')}`;
  const groups = new Map();
  for (const c of classes) {
    const room = c.room && c.room.trim() ? c.room.trim() : UNASSIGNED_ROOM;
    const key = `${c.day}|${room}`;
    if (!groups.has(key)) groups.set(key, { day: c.day, dayLabel: c.dayLabel, room, classes: [] });
    groups.get(key).classes.push(c);
  }

  const pages = Array.from(groups.values())
    .sort((a, b) => a.day.localeCompare(b.day) || a.room.localeCompare(b.room))
    .map((g) => ({
      dayLabel: g.dayLabel,
      room: g.room,
      classes: g.classes
        .sort((a, b) => a.hour_position - b.hour_position)
        .map((c) => ({
          className: c.class_name,
          dayLabel: c.dayLabel,
          timeLabel: c.timeLabel,
          checkInUrl: `${origin}/kiosk/class-checkin/classes/${c.id}/attendance`,
        })),
    }));

  res.render('admin-classcheckin-qr-print', {
    title: 'Print Class Check-In QR Codes',
    pages,
  });
});

// Playground Check-In QR Codes: a real request - "create qr codes for the
// playground check in link." Unlike Class Check-In QR Codes above, there's
// nothing to pick - the playground always has exactly the same 8
// (day, hour) slots (utils/playground.js) - so this always prints all of
// them, one page per day with the same 2x2 grid the class QR sheets use.
// Each QR code encodes that one hour's own Playground Check-In quick link
// (/kiosk/class-checkin/playground/:day/:hour/attendance) - absolute, for
// the same reason the class QR codes are: a QR code is scanned by a
// phone's camera with no browsing context to resolve a relative path
// against.
router.get('/design/print-playground-qr', async (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const pages = [];
  for (const day of DAYS) {
    const hours = [];
    for (const hour of HOUR_POSITIONS) {
      hours.push({
        hourLabel: await playgroundHourLabel(day, hour),
        checkInUrl: `${origin}/kiosk/class-checkin/playground/${day}/${hour}/attendance`,
      });
    }
    pages.push({ dayLabel: DAY_LABELS[day], hours });
  }

  res.render('admin-playground-qr-print', {
    title: 'Print Playground Check-In QR Codes',
    pages,
  });
});

// Library Barcodes: a real request - "Under printing add printing library
// barcodes. Drop down menu shows category choices. After selecting a
// category it shows a list of library catalog items in that category to
// print avery labels. Use the same template as the barcode only badges for
// members." Reuses the exact Avery 08160-style label sheet layout the
// member barcode-labels print already uses (admin-name-tag-barcode-labels-
// print.ejs / .avery-label-sheet-page in styles.css) - see admin-library-
// barcodes-print.ejs, the item-flavored twin of that same template.
router.post('/design/print-library-barcodes', async (req, res) => {
  const itemIds = [].concat(req.body.itemIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (itemIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one library item to print.'));
  }

  const placeholders = itemIds.map(() => '?').join(',');
  const items = (await db.prepare(`SELECT * FROM library_items WHERE id IN (${placeholders})`).all(...itemIds)).sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );

  res.render('admin-library-barcodes-print', {
    title: 'Print Library Barcodes',
    items,
  });
});

module.exports = router;
