// Co-op Admin's own Orientation tracker - a real request: "Add an
// orientation tab. List of members registered for classes on either day.
// Columns, member name, day Monday/Wednesday, orientation video,
// orientation meet up, teacher training and tour. The last four are
// circle check boxes that show green when complete... Percentage to
// complete at the end of the row. Subpages, tour check in, orientation
// check in. Check in pages look like class check in. Shows everyone
// register for classes on either day on one list. Check in purple button
// at the top. Copy link button for direct link to that check in page."
// See utils/orientation.js for the row model (one per primary parent/day
// pair) and the actual field-toggling logic.
const express = require('express');
const router = express.Router();
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { FIELDS, orientationRows, setOrientationField } = require('../utils/orientation');

router.get('/orientation', requireFullAdmin, async (req, res) => {
  const rows = await orientationRows();
  res.render('admin-orientation', { title: 'Orientation', rows, notice: req.query.notice || null, error: req.query.error || null });
});

// One circle's own toggle - fetch-on-click, same pattern public/js/
// class-settings-autosave.js already uses for the Class Settings tab's
// own checkboxes.
router.post('/orientation/:memberId/:day/toggle', requireFullAdmin, async (req, res) => {
  const memberId = parseInt(req.params.memberId, 10);
  const day = req.params.day;
  const field = req.body.field;
  if (!FIELDS.includes(field) || (day !== 'monday' && day !== 'wednesday')) {
    return res.status(400).json({ ok: false, error: 'Invalid field or day' });
  }
  await setOrientationField(memberId, day, field, req.body.value === '1');
  res.json({ ok: true });
});

// Both check-in subpages share the exact same shape (see views/admin-
// orientation-checkin.ejs): everyone from the main list, a purple "Check
// In" bulk-action button up top, and a Copy Link button for this page's
// own URL - only the field being checked in (tour vs meetup) differs.
function renderCheckinPage(field, title, postUrl) {
  return async (req, res) => {
    const rows = await orientationRows();
    res.render('admin-orientation-checkin', {
      title,
      field,
      postUrl,
      linkUrl: `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}`,
      rows,
      notice: req.query.notice || null,
    });
  };
}

function handleCheckin(field) {
  return async (req, res) => {
    const selected = [].concat(req.body.members || []);
    for (const key of selected) {
      const [memberId, day] = key.split(':');
      await setOrientationField(parseInt(memberId, 10), day, field, true);
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
