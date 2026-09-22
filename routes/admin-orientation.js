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
const { FIELDS, orientationRows, setOrientationField, defaultSemesterId, orientationLinks, setOrientationLink } = require('../utils/orientation');

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
  const links = await orientationLinks();
  res.render('admin-orientation', {
    title: 'Orientation',
    rows,
    semesters,
    semesterId,
    links,
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
// or check in with each circle check mark column so the information can
// be linked" - one optional URL per checkmark column, so its header can
// link out to the actual training video or check-in event.
router.get('/orientation/settings', requireFullAdmin, async (req, res) => {
  const links = await orientationLinks();
  res.render('admin-orientation-settings', { title: 'Orientation Settings', links, notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/orientation/settings', requireFullAdmin, async (req, res) => {
  for (const field of FIELDS) {
    await setOrientationLink(field, req.body[field]);
  }
  res.redirect('/admin/orientation/settings?notice=' + encodeURIComponent('Orientation settings saved.'));
});

// Both check-in subpages share the exact same shape (see views/admin-
// orientation-checkin.ejs): everyone from the main list, a purple "Check
// In" bulk-action button up top, and a Copy Link button for this page's
// own URL - only the field being checked in (tour vs meetup) differs.
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

router.get('/orientation/orientation-checkin', requireFullAdmin, renderCheckinPage('meetup', 'Orientation Check-In', '/admin/orientation/orientation-checkin'));
router.post('/orientation/orientation-checkin', requireFullAdmin, handleCheckin('meetup'));

module.exports = router;
