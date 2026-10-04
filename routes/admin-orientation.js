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
const { FIELDS, orientationRows, setOrientationField, defaultSemesterId, setOrientationLink, orientationTrainingLinks } = require('../utils/orientation');

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
  res.render('admin-orientation-settings', { title: 'Orientation Settings', trainingLinks, trainings, notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/orientation/settings', requireFullAdmin, async (req, res) => {
  for (const field of FIELDS) {
    const trainingId = req.body[field + 'TrainingId'] ? parseInt(req.body[field + 'TrainingId'], 10) : null;
    await setOrientationLink(field, trainingId);
  }
  res.redirect('/admin/orientation/settings?notice=' + encodeURIComponent('Orientation settings saved.'));
});

// Both check-in subpages share the exact same shape (see views/admin-
// orientation-checkin.ejs): everyone from the main list, a purple "Check
// In" bulk-action button up top, and a Copy Link button for this page's
// own URL - only the field being checked in (tour vs openHouse) differs.
function renderCheckinPage(field, title, postUrl) {
  return async (req, res) => {
    const semesterId = await resolveSemesterId(req);
    const rows = await orientationRows(semesterId);
    const query = req.query.semesterId ? `?semesterId=${encodeURIComponent(req.query.semesterId)}` : '';
    res.render('admin-orientation-checkin', {
      title,
      field,
      postUrl,
      semesterId,
      linkUrl: `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}${query}`,
      rows,
      notice: req.query.notice || null,
    });
  };
}

function handleCheckin(field) {
  return async (req, res) => {
    const semesterId = req.body.semesterId ? parseInt(req.body.semesterId, 10) : null;
    const selected = [].concat(req.body.members || []);
    for (const memberId of selected) {
      await setOrientationField(parseInt(memberId, 10), semesterId, field, true);
    }
    const back = req.body._backTo || `/admin/orientation/${field === 'tour' ? 'tour-checkin' : 'orientation-checkin'}`;
    res.redirect(back + '?notice=' + encodeURIComponent(`Checked in ${selected.length} member${selected.length === 1 ? '' : 's'}.`));
  };
}

router.get('/orientation/tour-checkin', requireFullAdmin, renderCheckinPage('tour', 'Tour Check-In', '/admin/orientation/tour-checkin'));
router.post('/orientation/tour-checkin', requireFullAdmin, handleCheckin('tour'));

// A real request: "Delete orientation Meet-up column", with "Orientation
// check in should be linked to open house column" - this subpage used to
// check in the (now-removed) Meet Up field; it now checks in Open House
// instead, same as the main grid's own Open House circle.
router.get('/orientation/orientation-checkin', requireFullAdmin, renderCheckinPage('openHouse', 'Open House Check-In', '/admin/orientation/orientation-checkin'));
router.post('/orientation/orientation-checkin', requireFullAdmin, handleCheckin('openHouse'));

module.exports = router;
