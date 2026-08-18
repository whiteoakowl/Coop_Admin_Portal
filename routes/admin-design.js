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
const { buildDuplexPages } = require('../utils/duplexPrint');
const { buildCardPairs } = require('../utils/cardPairs');
const { formatDateLabel, formatTimestamp } = require('../utils/dates');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { paginate, parsePage } = require('../utils/pagination');
const { allClassesList } = require('../utils/classSchedule');

router.use(requireFullAdmin);

const DESIGN_TYPES = ['student', 'parent', 'scheduleCard', 'setupCleanup', 'custom'];
const TABS = ['design', 'print', 'requests'];

const REQUEST_TYPE_LABELS = { lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
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
  let sql = `SELECT n.id AS id, m.name AS "memberName", n.request_type AS "requestType", n.day AS day,
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
  const requestsPagination = paginate(allSubmissions, parsePage(req.query.page));

  res.render('admin-design', {
    title: 'Design / Print',
    tab,
    initialType,
    members,
    classesForQr,
    error: req.query.error || null,
    initialPrintPanel: ['setupCleanupBadges', 'customBadges'].includes(req.query.print) ? req.query.print : null,
    notice: req.query.notice || null,
    setupCleanupBadges: await listMiscBadges('setupCleanup'),
    customBadges: await listMiscBadges('custom'),
    submissions: requestsPagination.items,
    allSubmissions,
    pagination: requestsPagination,
    baseHref: `/admin/design?tab=requests${showArchived ? '&archived=1' : ''}${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
    dates: requestDates,
    dateFilter,
    showArchived,
    nameTagDataJson: jsonScriptSafe({
      templates: {
        student: await getTemplate('student'),
        parent: await getTemplate('parent'),
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
router.post('/design/print-classcheckin-qr', async (req, res) => {
  const classIds = [].concat(req.body.classIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (classIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one class to print.'));
  }

  const allClasses = await allClassesList();
  const idSet = new Set(classIds);
  // Keep allClassesList's own sort order rather than whatever order the
  // submitted checkboxes happened to arrive in (checkbox form fields
  // don't reliably preserve on-page order across browsers).
  const classes = allClasses.filter((c) => idSet.has(c.id));

  const origin = `${req.protocol}://${req.get('host')}`;
  const pages = [];
  for (let i = 0; i < classes.length; i += 4) {
    pages.push(
      classes.slice(i, i + 4).map((c) => ({
        className: c.class_name,
        dayLabel: c.dayLabel,
        timeLabel: c.timeLabel,
        checkInUrl: `${origin}/kiosk/class-checkin/classes/${c.id}/attendance`,
      }))
    );
  }

  res.render('admin-classcheckin-qr-print', {
    title: 'Print Class Check-In QR Codes',
    pages,
  });
});

module.exports = router;
