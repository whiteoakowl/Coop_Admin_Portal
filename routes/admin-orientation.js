// Co-op Admin's own Orientation tracker - a real request: "Add an
// orientation tab. List of members registered for classes on either day.
// Columns, member name, day Monday/Wednesday, orientation video,
// orientation meet up, teacher training and tour. The last four are
// circle check boxes that show green when complete... Percentage to
// complete at the end of the row. Subpages, tour check in, orientation
// check in. Check in pages look like class check in. Shows everyone
// register for classes on either day on one list. Check in purple button
// at the top. Copy link button for direct link to that check in page."
//
// Later rebuilt semester-scoped - see utils/orientation.js's own header
// comment for the data-model shift and views/admin-orientation-settings.ejs
// for the per-column link feature.
const express = require('express');
const router = express.Router();
const requireFullAdmin = require('../middleware/requireFullAdmin');
const db = require('../db');
const { FIELDS, LINKABLE_FIELDS, orientationRows, setOrientationField, defaultSemesterId, setOrientationLink, orientationTrainingLinks, orientationObligationMemberId } = require('../utils/orientation');
const { findMemberByBarcodeOrName } = require('../utils/memberLookup');

// Shared by every page in this router - `?semesterId=` if given, else the
// most recently created semester, else null (the fallback "every class
// regardless of semester" view for a co-op that hasn't created any
// semesters yet - see orientationRows' own comment).
async function resolveSemesterId(req) {
  if (req.query.semesterId === 'none') return null;
  if (req.query.semesterId) return parseInt(req.query.semesterId, 10);
  return defaultSemesterId();
}

router.get('/orientation', requireFullAdmin, async (req, res) => {
  const semesters = await db.prepare('SELECT * FROM semesters ORDER BY id DESC').all();
  const semesterId = await resolveSemesterId(req);
  const rows = await orientationRows(semesterId);
  const trainingLinks = await orientationTrainingLinks();
  res.render('admin-orientation', {
    title: 'Orientation Tracking',
    rows,
    semesters,
    semesterId,
    trainingLinks,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// One circle's own toggle - fetch-on-click, same pattern public/js/
// class-settings-autosave.js already uses for the Class Settings tab's
// own checkboxes.
router.post('/orientation/:memberId/toggle', requireFullAdmin, async (req, res) => {
  const memberId = parseInt(req.params.memberId, 10);
  const field = req.body.field;
  const semesterId = req.body.semesterId ? parseInt(req.body.semesterId, 10) : null;
  if (!FIELDS.includes(field)) {
    return res.status(400).json({ ok: false, error: 'Invalid field' });
  }
  await setOrientationField(memberId, semesterId, field, req.body.value === '1');
  res.json({ ok: true });
});

// A real request: "Add button for orientation settings to Link training
// ... with each circle check mark column", later refined to "the links
// for the column check boxes should be dropdown menus of trainings that
// have been created" - one optional Training per checkmark column
// (picked from a dropdown), so its header can link straight to that
// Training and completing it there auto-checks the column.
router.get('/orientation/settings', requireFullAdmin, async (req, res) => {
  const trainingLinks = await orientationTrainingLinks();
  // Draft/archived trainings can still be linked (an admin may set this
  // up before publishing, or keep it after archiving a training that's
  // done its job) - every training is offered, not just published ones.
  const trainings = await db.prepare('SELECT id, title FROM trainings ORDER BY title').all();
  res.render('admin-orientation-settings', { title: 'Orientation Settings', trainingLinks, trainings, linkableFields: LINKABLE_FIELDS, notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/orientation/settings', requireFullAdmin, async (req, res) => {
  for (const [field] of LINKABLE_FIELDS) {
    const trainingId = req.body[field + 'TrainingId'] ? parseInt(req.body[field + 'TrainingId'], 10) : null;
    await setOrientationLink(field, trainingId);
  }
  res.redirect('/admin/orientation/settings?notice=' + encodeURIComponent('Orientation settings saved.'));
});

// Both check-in subpages share the exact same shape (see views/admin-
// orientation-checkin.ejs): everyone from the main list (status-only, no
// more bulk-select checkboxes - see handleScan below for why), a purple
// "Check In" button up top that opens the scan screen, a semester
// dropdown matching Orientation Tracking's own, and a Copy Link button
// for this page's own URL - only the field being checked in (tour vs
// openHouse) differs.
function renderCheckinPage(field, title, basePath) {
  return async (req, res) => {
    const semesters = await db.prepare('SELECT * FROM semesters ORDER BY id DESC').all();
    const semesterId = await resolveSemesterId(req);
    const rows = await orientationRows(semesterId);
    const query = req.query.semesterId ? `?semesterId=${encodeURIComponent(req.query.semesterId)}` : '';
    res.render('admin-orientation-checkin', {
      title,
      field,
      basePath,
      semesters,
      semesterId,
      linkUrl: `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}${query}`,
      rows,
      notice: req.query.notice || null,
    });
  };
}

// A real request: "click check in button should have same card screen as
// kiosk with mobile scan, barcode scan or enter ID button choices." Same
// method-chooser markup/JS the Class Check-In kiosk and the Events scan
// page already use (views/kiosk-class-checkin-scan.ejs, views/admin-
// events-checkin-scan.ejs) - carries the semester the admin had selected
// on the list page through as the scan target, and a Complete button
// (same continuous-scan-then-exit pattern the kiosk version already has)
// to return to that list afterward.
function renderScanPage(heading, basePath) {
  return async (req, res) => {
    const semesterId = await resolveSemesterId(req);
    const semesterQuery = semesterId != null ? `?semesterId=${semesterId}` : '';
    res.render('admin-orientation-checkin-scan', {
      title: `${heading} Scan`,
      heading,
      semesterId,
      scanPostUrl: `${basePath}/scan`,
      completeUrl: `${basePath}${semesterQuery}`,
    });
  };
}

// The scan endpoint behind the card screen's 3 entry methods. Resolves
// whoever was scanned/typed through the exact same family-obligation
// lookup a passed Training already uses (utils/orientation.js's own
// orientationObligationMemberId) - it doesn't matter which family member
// actually walks up and scans their own barcode, the checkmark always
// lands on the same Primary Parent row the list above (and Orientation
// Tracking itself) already shows for that family.
function handleScan(field) {
  return async (req, res) => {
    const semesterId = req.body.semesterId ? parseInt(req.body.semesterId, 10) : null;
    const { member, ambiguous } = await findMemberByBarcodeOrName(req.body.barcode);
    if (ambiguous) return res.json({ ok: false, message: 'More than one member has that name - please scan a barcode instead.' });
    if (!member) return res.json({ ok: false, message: 'Not recognized.' });

    const targetMemberId = await orientationObligationMemberId(member.id);
    const rows = await orientationRows(semesterId);
    const familyRow = rows.find((r) => r.memberId === targetMemberId);
    if (!familyRow) return res.json({ ok: false, message: `${member.name} is not registered for classes this semester.` });

    if (familyRow[field]) return res.json({ ok: true, alreadyChecked: true, message: `${member.name} is already checked in.` });

    await setOrientationField(targetMemberId, semesterId, field, true);
    res.json({ ok: true, message: `Welcome, ${member.name}!` });
  };
}

router.get('/orientation/tour-checkin', requireFullAdmin, renderCheckinPage('tour', 'Tour Check-In', '/admin/orientation/tour-checkin'));
router.get('/orientation/tour-checkin/scan', requireFullAdmin, renderScanPage('Tour Check-In', '/admin/orientation/tour-checkin'));
router.post('/orientation/tour-checkin/scan', requireFullAdmin, handleScan('tour'));

// A real request: "Delete orientation Meet-up column", with "Orientation
// check in should be linked to open house column" - this subpage used to
// check in the (now-removed) Meet Up field; it now checks in Open House
// instead, same as the main grid's own Open House circle.
router.get('/orientation/orientation-checkin', requireFullAdmin, renderCheckinPage('openHouse', 'Open House Check-In', '/admin/orientation/orientation-checkin'));
router.get('/orientation/orientation-checkin/scan', requireFullAdmin, renderScanPage('Open House Check-In', '/admin/orientation/orientation-checkin'));
router.post('/orientation/orientation-checkin/scan', requireFullAdmin, handleScan('openHouse'));

module.exports = router;
