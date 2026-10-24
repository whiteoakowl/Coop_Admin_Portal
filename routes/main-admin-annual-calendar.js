// Main Admin: Annual Calendar - a real request: "Main admin portal, add a
// tab called annual calendar. This calendar will work similar to the
// family school management attendance calendar where you can click on
// the dates to change the color. Mobile and desktop view should show the
// full 12 month calendar, shrink to fit. Should print and pdf on one
// page. Dropdown menu for each fiscal year created in the system. Can
// create a calendar for each fiscal year. Create key button. Be able to
// add a label and color for each key item. Key shows on page. Be able to
// click each key then click on the calendar dates to color/key each one
// that particular key. Click on a new key and repeat the process. This
// will also be a quick links on parent portal and in admin settings
// gear." See utils/annualCalendar.js for the data model/CRUD this route
// file is a thin wrapper over.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const annualCalendar = require('../utils/annualCalendar');
const { renderViewToPdf } = require('../utils/pdfRender');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_annual_calendar'));

// Every fiscal year, the calendar for the selected one (if created yet),
// its keys, and the 12-month grid - everything the live view needs in
// one shared loader, reused by the print/download.pdf routes below too.
async function loadCalendarPageData(req) {
  const fiscalYears = await annualCalendar.listFiscalYears();
  const fiscalYearsWithLabel = fiscalYears.map((fy) => ({ ...fy, label: annualCalendar.fiscalYearLabel(fy) }));
  const selectedFiscalYearId = req.query.fiscalYearId ? parseInt(req.query.fiscalYearId, 10) : fiscalYears[0] ? fiscalYears[0].id : null;
  const selectedFiscalYear = fiscalYearsWithLabel.find((fy) => fy.id === selectedFiscalYearId) || null;
  const calendar = selectedFiscalYear ? await annualCalendar.calendarForFiscalYear(selectedFiscalYear.id) : null;
  const keys = calendar ? await annualCalendar.keysForCalendar(calendar.id) : [];
  const keyByDate = calendar ? await annualCalendar.keyByDateForCalendar(calendar.id) : {};
  const months = selectedFiscalYear ? annualCalendar.monthsForFiscalYear(selectedFiscalYear, keyByDate) : [];
  return { fiscalYears: fiscalYearsWithLabel, selectedFiscalYearId, selectedFiscalYear, calendar, keys, months };
}

router.get('/', async (req, res) => {
  const data = await loadCalendarPageData(req);
  res.render('main-admin-annual-calendar', {
    title: 'Annual Calendar',
    MONTH_NAMES: annualCalendar.MONTH_NAMES,
    notice: req.query.notice || null,
    error: req.query.error || null,
    annualCalendarDefaults: { monthRowColor: annualCalendar.DEFAULT_MONTH_ROW_COLOR, weekdayRowColor: annualCalendar.DEFAULT_WEEKDAY_ROW_COLOR },
    ...data,
  });
});

router.post('/create', async (req, res) => {
  const fiscalYearId = parseInt(req.body.fiscalYearId, 10);
  if (!fiscalYearId) return res.redirect('/main-admin/annual-calendar?error=' + encodeURIComponent('Choose a fiscal year first.'));
  await annualCalendar.createCalendar(fiscalYearId);
  res.redirect(`/main-admin/annual-calendar?fiscalYearId=${fiscalYearId}&notice=` + encodeURIComponent('Calendar created.'));
});

// A real request: "Be able to add a new key and stay in the popup and
// it will appear in the list below." AJAX now (public/js/annual-
// calendar-keys.js) instead of the old form POST+redirect - same no-
// page-reload shape public/js/annual-planner-curriculum.js's own
// delete already uses.
router.post('/keys', async (req, res) => {
  const calendarId = parseInt(req.body.calendarId, 10);
  const label = (req.body.label || '').trim();
  if (!calendarId || !label) return res.status(400).json({ ok: false, message: 'A key needs a label.' });
  const key = await annualCalendar.createKey(calendarId, label, req.body.color);
  res.json({ ok: true, key: { id: key.id, label: key.label, color: key.color } });
});

// A real request: "Also a save changes button at the bottom... Be able
// to edit existing keys and click save changes." One bulk update for
// every key row in the dialog, replacing the old per-field auto-submit.
router.post('/keys/bulk-update', async (req, res) => {
  const updates = Array.isArray(req.body.keys) ? req.body.keys : [];
  for (const k of updates) {
    const id = parseInt(k.id, 10);
    const label = (k.label || '').trim();
    if (!id || !label) continue;
    await annualCalendar.updateKey(id, label, k.color);
  }
  res.json({ ok: true });
});

router.post('/keys/:id/delete', async (req, res) => {
  await annualCalendar.deleteKey(req.params.id);
  res.json({ ok: true });
});

// A real request: "Add edit calendar colors buttons. This button will
// allow you to set the color for the month row and set the color for
// the days of the week row." AJAX, same shape as the Keys dialog's own
// save (public/js/annual-calendar-colors.js) - updates in place without
// a page reload.
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
router.post('/colors', async (req, res) => {
  const calendarId = parseInt(req.body.calendarId, 10);
  if (!calendarId) return res.status(400).json({ ok: false, message: 'No calendar selected.' });
  const monthRowColor = (req.body.monthRowColor || '').trim();
  const weekdayRowColor = (req.body.weekdayRowColor || '').trim();
  if ((monthRowColor && !HEX_COLOR.test(monthRowColor)) || (weekdayRowColor && !HEX_COLOR.test(weekdayRowColor))) {
    return res.status(400).json({ ok: false, message: 'Colors must be a valid hex color.' });
  }
  await annualCalendar.updateCalendarColors(calendarId, monthRowColor, weekdayRowColor);
  res.json({ ok: true });
});

// AJAX endpoint (public/js/annual-calendar.js) - clicking a date while a
// key is selected applies that key, clicking it again clears it, same
// one-request-per-click/no-page-reload shape public/js/family-school-
// attendance.js already uses.
router.post('/days/toggle', async (req, res) => {
  const calendarId = parseInt(req.body.calendarId, 10);
  const keyId = parseInt(req.body.keyId, 10);
  const date = (req.body.date || '').trim();
  if (!calendarId || !keyId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false });
  const key = await annualCalendar.toggleDay(calendarId, date, keyId);
  res.json({ ok: true, key: key ? { id: key.id, label: key.label, color: key.color } : null });
});

router.get('/print', async (req, res) => {
  const data = await loadCalendarPageData(req);
  res.render('main-admin-annual-calendar-print', {
    title: 'Annual Calendar',
    MONTH_NAMES: annualCalendar.MONTH_NAMES,
    schoolYearLabel: data.selectedFiscalYear ? annualCalendar.fiscalYearSchoolYearLabel(data.selectedFiscalYear) : null,
    ...data,
  });
});

// A real request: "should print and pdf on one page" - the exact same
// -print.ejs view the Print button opens, rendered to a real PDF (utils/
// pdfRender.js) instead of just previewed.
router.get('/download.pdf', async (req, res) => {
  const data = await loadCalendarPageData(req);
  const pdf = await renderViewToPdf(req, 'main-admin-annual-calendar-print', {
    title: 'Annual Calendar',
    MONTH_NAMES: annualCalendar.MONTH_NAMES,
    schoolYearLabel: data.selectedFiscalYear ? annualCalendar.fiscalYearSchoolYearLabel(data.selectedFiscalYear) : null,
    ...data,
  });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="annual-calendar.pdf"');
  res.send(pdf);
});

module.exports = router;
