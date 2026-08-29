// Main Admin's own Events management (Community & Commerce track, item
// 1) - mounted at /main-admin/events (server.js), gated the same way
// every other Main Admin section is: requirePortalAuth + requirePortal
// ('main_admin') + requirePortalPermission('manage_events'), matching
// routes/main-admin.js's own pattern (read that file, not duplicated
// here, since it's on Track A's hard-boundary "don't touch" list - this
// is a sibling router, not an edit to it).
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { sanitizePostBody } = require('../utils/sanitizeHtml');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, publicUrl, generateKey } = require('../utils/storage');
const { formatFriendlyTimestamp } = require('../utils/dates');
const db = require('../db');
const events = require('../utils/events');
const auditLog = require('../utils/auditLog');
const { findMemberByBarcodeOrName } = require('../utils/memberLookup');
const { buildTemplateWorkbook, readRowsFromFile, sendCsv } = require('../utils/spreadsheet');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_events'));

// Shared by the Create/Edit forms and the member-submission approval flow
// below - the registration-rules field set the events migration added
// (window dates, family cap, age/grade, adult/child gating, pricing).
function registrationFieldsFromBody(body) {
  return {
    categoryId: body.categoryId ? parseInt(body.categoryId, 10) : null,
    familyCapacity: body.familyCapacity ? parseInt(body.familyCapacity, 10) : null,
    ageGroup: [].concat(body.ageGroup || []).join(', '),
    registrationOpensAt: toSqlTimestamp(body.registrationOpensAt),
    registrationClosesAt: toSqlTimestamp(body.registrationClosesAt),
    allowAdultRegister: body.allowAdultRegister !== 'off',
    allowChildRegister: body.allowChildRegister !== 'off',
    priceCents: body.priceDollars ? Math.round(parseFloat(body.priceDollars) * 100) : null,
    pricePer: body.pricePer === 'family' ? 'family' : 'person',
  };
}

// Public bucket (event images are meant to be visible on the public
// homepage too, unlike admin-documents.js's private `documents` bucket)
// - same publicUrl()-or-local-disk pattern admin-name-tag.js/admin-
// schedule.js already use for their own public-facing images.
const EVENT_IMAGES_BUCKET = 'event-images';
const EVENT_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'events');
if (!createStorageClient() && !fs.existsSync(EVENT_IMAGE_DIR)) fs.mkdirSync(EVENT_IMAGE_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

function imageUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(EVENT_IMAGES_BUCKET, key) : `/uploads/events/${key}`;
}

// Converts an <input type="datetime-local"> value ("2026-09-01T18:00")
// straight into the "YYYY-MM-DD HH:MM:SS" text shape now_text()/every
// other timestamp column in this app already uses, treating the value
// the admin typed as already being in the co-op's own Eastern time (same
// assumption utils/dates.js's formatTime/formatFriendlyTimestamp make
// when displaying it back) - stored as literal UTC-labeled text without
// an actual timezone conversion, matching how every other plain-text
// timestamp column in this schema already works.
function toSqlTimestamp(datetimeLocal) {
  if (!datetimeLocal) return null;
  return datetimeLocal.replace('T', ' ') + ':00';
}

// A real request: "Main Admin Events: Calendar/Drafts/Requests/Event
// Attendance/Archive/Settings tabs." Calendar = published (live) events
// on a real month grid (utils/events.js's own monthGrid, shared with the
// member-facing /events?view=calendar); Drafts = created-but-not-yet-
// published events (status 'draft', decided submissions included -
// pending ones stay on Requests only); Requests = member submissions
// awaiting a yes/no (the former standalone /pending page); Attendance =
// a jumping-off point to each published event's own check-in/registrations
// page (routes below, unchanged); Archive = cancelled events; Settings =
// event categories (the former standalone /categories page).
const EVENTS_TABS = ['calendar', 'drafts', 'requests', 'attendance', 'archive', 'settings'];

router.get('/', async (req, res) => {
  const activeTab = EVENTS_TABS.includes(req.query.tab) ? req.query.tab : 'calendar';
  const pending = await events.listEvents({ approvalStatus: 'pending' });
  const pendingCount = pending.length;

  let calendar = null;
  let calendarView = 'calendar';
  let calendarList = [];
  let drafts = [];
  let requests = [];
  let attendance = [];
  let archived = [];
  // Always loaded (not just for the Settings tab) - the New Event
  // dialog's own Category/Location dropdowns are reachable from the
  // Calendar and Drafts tabs too.
  const categories = await events.listCategories();
  const locations = await events.listLocations();
  const eventSettings = await events.getEventSettings();
  if (activeTab === 'calendar') {
    const published = await events.listEvents({ status: 'published' });
    calendar = events.monthGrid(req.query.month, published);
    calendarView = req.query.view === 'list' ? 'list' : 'calendar';
    if (calendarView === 'list') {
      calendarList = calendar.weeks
        .flat()
        .filter((day) => day.inMonth)
        .flatMap((day) => day.events)
        .map((e) => ({ ...e, startsLabel: formatFriendlyTimestamp(e.starts_at) }));
    }
  } else if (activeTab === 'drafts') {
    drafts = (await events.listEvents({ status: 'draft' })).filter((e) => e.approval_status !== 'pending');
  } else if (activeTab === 'requests') {
    requests = pending.map((e) => ({ ...e, startsLabel: formatFriendlyTimestamp(e.starts_at) }));
  } else if (activeTab === 'attendance') {
    const published = await events.listEvents({ status: 'published' });
    attendance = await Promise.all(
      published.map(async (e) => ({ ...e, startsLabel: formatFriendlyTimestamp(e.starts_at), registrationCount: await events.registrationCountForEvent(e.id) }))
    );
  } else if (activeTab === 'archive') {
    archived = await events.listEvents({ status: 'cancelled' });
  }

  res.render('admin-events-list', {
    title: 'Events',
    activeTab,
    pendingCount,
    calendar,
    calendarView,
    calendarList,
    monthParam: req.query.month || '',
    drafts,
    requests,
    attendance,
    archived,
    categories,
    locations,
    eventSettings,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/categories', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/events?tab=settings&error=' + encodeURIComponent('Category name is required.'));
  await events.createCategory(name, req.body.color, req.body.allowSync !== undefined);
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Category added.'));
});

router.post('/categories/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/events?tab=settings&error=' + encodeURIComponent('Category name is required.'));
  await events.updateCategory(req.params.id, name, req.body.color, req.body.allowSync !== undefined);
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Category updated.'));
});

router.post('/categories/:id/delete', async (req, res) => {
  await events.deleteCategory(req.params.id);
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Category removed.'));
});

// --- Locations (item 8) ---

router.post('/locations', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/events?tab=settings&error=' + encodeURIComponent('Location name is required.'));
  await events.createLocation(name, (req.body.address || '').trim());
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Location added.'));
});

router.post('/locations/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/events?tab=settings&error=' + encodeURIComponent('Location name is required.'));
  await events.updateLocation(req.params.id, name, (req.body.address || '').trim());
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Location updated.'));
});

router.post('/locations/:id/delete', async (req, res) => {
  await events.deleteLocation(req.params.id);
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Location removed.'));
});

// --- Settings (item 9) ---

router.post('/settings', async (req, res) => {
  await events.updateEventSettings({
    defaultCalendarView: req.body.defaultCalendarView,
    showWaitlistPosition: req.body.showWaitlistPosition !== undefined,
    reminderDaysBefore: req.body.reminderDaysBefore,
    creditOnFamilyCancel: req.body.creditOnFamilyCancel === '1',
    creditOnAdminCancel: req.body.creditOnAdminCancel === '1',
    subadminEditLocations: req.body.subadminEditLocations === '1',
    subadminEditCategories: req.body.subadminEditCategories === '1',
    familySubmitEvents: req.body.familySubmitEvents,
    submitNotificationEmail: req.body.submitNotificationEmail,
    familyManagePriceOptions: req.body.familyManagePriceOptions === '1',
    familyManageOwnEvents: req.body.familyManageOwnEvents === '1',
    familyEventsPublicDefault: req.body.familyEventsPublicDefault === '1',
  });
  res.redirect('/main-admin/events?tab=settings&notice=' + encodeURIComponent('Settings saved.'));
});

router.post('/:id/decide', async (req, res) => {
  const approve = req.body.decision === 'approve';
  const result = await events.decideSubmission(req.params.id, approve);
  if (!result) return res.redirect('/main-admin/events?tab=requests&notice=' + encodeURIComponent('That submission was already decided.'));
  res.redirect('/main-admin/events?tab=requests&notice=' + encodeURIComponent(`Submission ${result}.`));
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  const startsAt = toSqlTimestamp(req.body.startsAt);
  if (!title || !startsAt) {
    return res.redirect('/main-admin/events?notice=' + encodeURIComponent('Title and start date/time are required.'));
  }
  const id = await events.createEvent(
    {
      title,
      description: sanitizePostBody(req.body.description || ''),
      category: (req.body.category || '').trim(),
      location: (req.body.location || '').trim(),
      locationId: req.body.locationId ? parseInt(req.body.locationId, 10) : null,
      startsAt,
      endsAt: toSqlTimestamp(req.body.endsAt),
      visibility: req.body.visibility === 'public' ? 'public' : 'members',
      capacity: req.body.capacity ? parseInt(req.body.capacity, 10) : null,
      ...registrationFieldsFromBody(req.body),
    },
    req.portalAccount.id
  );
  await events.setEventSections(id, req.body.sectionIds);
  res.redirect(`/main-admin/events/${id}/builder`);
});

// --- CSV export/import (item 5) - registered before the /:id param
// routes below so their literal paths never get shadowed by :id. ---

router.get('/export.csv', async (req, res) => {
  const all = await events.listEvents();
  sendCsv(res, 'events.csv', events.buildEventsExportCsvLines(all));
});

router.get('/import-template.xlsx', (req, res) => {
  const buffer = buildTemplateWorkbook(events.EVENT_EXPORT_HEADER, [
    ['Fall Family Picnic', '2026-10-10 18:00', '2026-10-10 20:00', 'Fellowship Hall', 'Social', 'members', '50', 'Bring a dish to share.'],
  ]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="events-import-template.xlsx"');
  res.send(buffer);
});

const importUpload = multer({ storage: multer.memoryStorage() });
router.post('/import', importUpload.single('file'), async (req, res) => {
  if (!req.file) return res.redirect('/main-admin/events?error=' + encodeURIComponent('Please choose a file to import.'));
  let rows;
  try {
    rows = await readRowsFromFile(req.file.buffer);
  } catch (err) {
    return res.redirect('/main-admin/events?error=' + encodeURIComponent(err.message));
  }
  const { imported, errors } = await events.importEventsFromRows(rows, req.portalAccount.id);
  const notice = `Imported ${imported} event(s) as drafts.${errors.length ? ` ${errors.length} row(s) skipped.` : ''}`;
  res.redirect('/main-admin/events?tab=drafts&notice=' + encodeURIComponent(notice));
});

async function loadBuilder(req, res) {
  const event = await events.getEventWithDetails(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-events-builder', {
    title: event.title,
    event,
    imageUrl: imageUrl(event.image_key),
    categories: await events.listCategories(),
    locations: await events.listLocations(),
    sections: await db.prepare('SELECT * FROM sections ORDER BY name').all(),
    gradeOptions: events.GRADE_OPTIONS,
    selectedGrades: events.parseAgeGroupList(event.age_group),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}

router.get('/:id/builder', loadBuilder);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const title = (req.body.title || '').trim();
  const startsAt = toSqlTimestamp(req.body.startsAt);
  if (!title || !startsAt) {
    return res.redirect(`/main-admin/events/${id}/builder?error=` + encodeURIComponent('Title and start date/time are required.'));
  }
  await events.updateEvent(id, {
    title,
    description: sanitizePostBody(req.body.description || ''),
    category: (req.body.category || '').trim(),
    location: (req.body.location || '').trim(),
    locationId: req.body.locationId ? parseInt(req.body.locationId, 10) : null,
    startsAt,
    endsAt: toSqlTimestamp(req.body.endsAt),
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
    capacity: req.body.capacity ? parseInt(req.body.capacity, 10) : null,
    ...registrationFieldsFromBody(req.body),
  });
  await events.setEventSections(id, req.body.sectionIds);
  res.redirect(`/main-admin/events/${id}/builder?notice=` + encodeURIComponent('Settings saved.'));
});

// Item 11 - the Attendance tab's title-click quick-edit popup. Deliberately
// separate from POST /:id above - see updateEventQuickFields's own
// comment for why reusing that full-update route would be a real bug.
router.post('/:id/quick-edit', async (req, res) => {
  const title = (req.body.title || '').trim();
  const startsAt = toSqlTimestamp(req.body.startsAt);
  if (!title || !startsAt) {
    return res.redirect('/main-admin/events?tab=attendance&error=' + encodeURIComponent('Title and start date/time are required.'));
  }
  await events.updateEventQuickFields(req.params.id, {
    title,
    description: sanitizePostBody(req.body.description || ''),
    locationId: req.body.locationId ? parseInt(req.body.locationId, 10) : null,
    startsAt,
    endsAt: toSqlTimestamp(req.body.endsAt),
    categoryId: req.body.categoryId ? parseInt(req.body.categoryId, 10) : null,
    visibility: req.body.visibility,
    capacity: req.body.capacity ? parseInt(req.body.capacity, 10) : null,
  });
  res.redirect('/main-admin/events?tab=attendance&notice=' + encodeURIComponent('Event updated.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'published', 'cancelled'].includes(status)) return res.redirect(`/main-admin/events/${req.params.id}/builder`);
  await events.setEventStatus(req.params.id, status);
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent(`Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  const event = await events.getEvent(req.params.id);
  await events.deleteEvent(req.params.id);
  await auditLog.record(req.portalAccount.id, 'event_deleted', 'event', req.params.id, event?.title);
  res.redirect('/main-admin/events?notice=' + encodeURIComponent('Event deleted.'));
});

router.post('/:id/image', upload.single('image'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.redirect(`/main-admin/events/${id}/builder?error=` + encodeURIComponent('Please choose an image file.'));
  const client = createStorageClient();
  let key;
  try {
    if (client) {
      key = await uploadFile(client, EVENT_IMAGES_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      key = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(EVENT_IMAGE_DIR, key), req.file.buffer);
    }
  } catch (err) {
    return res.redirect(`/main-admin/events/${id}/builder?error=` + encodeURIComponent(`Upload failed: ${err.message}`));
  }
  const event = await events.getEvent(id);
  if (event && event.image_key) {
    if (client) await deleteFile(client, EVENT_IMAGES_BUCKET, event.image_key);
    else {
      const oldPath = path.join(EVENT_IMAGE_DIR, event.image_key);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  await events.setEventImage(id, key);
  res.redirect(`/main-admin/events/${id}/builder?notice=` + encodeURIComponent('Image updated.'));
});

// --- Volunteer roles ---

router.post('/:id/volunteer-roles', async (req, res) => {
  const roleName = (req.body.roleName || '').trim();
  if (!roleName) return res.redirect(`/main-admin/events/${req.params.id}/builder?error=` + encodeURIComponent('Role name is required.'));
  await events.addVolunteerRole(req.params.id, {
    roleName,
    slotsNeeded: parseInt(req.body.slotsNeeded, 10) || 1,
    timeLabel: (req.body.timeLabel || '').trim(),
    location: (req.body.location || '').trim(),
    description: (req.body.description || '').trim(),
  });
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent('Volunteer role added.'));
});

router.post('/:id/volunteer-roles/:roleId/update', async (req, res) => {
  await events.updateVolunteerRole(req.params.roleId, {
    roleName: (req.body.roleName || '').trim(),
    slotsNeeded: parseInt(req.body.slotsNeeded, 10) || 1,
    timeLabel: (req.body.timeLabel || '').trim(),
    location: (req.body.location || '').trim(),
    description: (req.body.description || '').trim(),
  });
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent('Volunteer role updated.'));
});

router.post('/:id/volunteer-roles/:roleId/delete', async (req, res) => {
  await events.deleteVolunteerRole(req.params.roleId);
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent('Volunteer role removed.'));
});

// --- Donation items ---

router.post('/:id/donation-items', async (req, res) => {
  const itemName = (req.body.itemName || '').trim();
  if (!itemName) return res.redirect(`/main-admin/events/${req.params.id}/builder?error=` + encodeURIComponent('Item name is required.'));
  await events.addDonationItem(req.params.id, {
    itemName,
    quantityNeeded: parseInt(req.body.quantityNeeded, 10) || 1,
    deadline: req.body.deadline || null,
    notes: (req.body.notes || '').trim(),
  });
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent('Donation item added.'));
});

router.post('/:id/donation-items/:itemId/update', async (req, res) => {
  await events.updateDonationItem(req.params.itemId, {
    itemName: (req.body.itemName || '').trim(),
    quantityNeeded: parseInt(req.body.quantityNeeded, 10) || 1,
    deadline: req.body.deadline || null,
    notes: (req.body.notes || '').trim(),
  });
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent('Donation item updated.'));
});

router.post('/:id/donation-items/:itemId/delete', async (req, res) => {
  await events.deleteDonationItem(req.params.itemId);
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent('Donation item removed.'));
});

// --- Registrations report, manual check-in/out, and guest registration ---

router.get('/:id/registrations', async (req, res) => {
  const event = await events.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const registrations = await events.registrationsForEvent(req.params.id);
  const guestRegistrations = events.sortByLastNameField(
    await db.prepare("SELECT * FROM event_guest_registrations WHERE event_id = ? AND status != 'cancelled'").all(req.params.id),
    'guest_name'
  );
  res.render('admin-events-registrations', {
    title: `Registrations - ${event.title}`,
    event,
    registrations,
    guestRegistrations,
    canRegisterGuests: req.portalPermissions.has('register_guests'),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: "events should have ability to scan name tags to check
// in or out for an event or manually check p, a on roster." The manual
// toggle below flips one registration/guest row directly by its own row
// id (the roster page's own P/A buttons); this scan endpoint instead
// resolves a member by barcode (utils/memberLookup.js, the same lookup
// the kiosk Class Check-In scan uses) and finds *their* registration row
// for this event - a name tag has no row id printed on it, only the
// member's own barcode.
router.post('/:id/scan', async (req, res) => {
  const eventId = req.params.id;
  const mode = req.body.mode === 'checkout' ? 'checkout' : 'checkin';
  const { member, ambiguous } = await findMemberByBarcodeOrName(req.body.barcode);
  if (ambiguous) return res.json({ ok: false, message: 'More than one member has that name - please scan a barcode instead.' });
  if (!member) return res.json({ ok: false, message: 'Not recognized.' });

  const registration = await db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status = 'confirmed'").get(eventId, member.id);
  if (!registration) return res.json({ ok: false, message: `${member.name} is not registered for this event.` });

  await events.setRegistrationCheckedIn(registration.id, mode === 'checkin');
  res.json({ ok: true, name: member.name, message: mode === 'checkin' ? `Welcome, ${member.name}!` : `${member.name} checked out.` });
});

router.post('/:id/registrations/:regId/checkin', async (req, res) => {
  await events.setRegistrationCheckedIn(req.params.regId, req.body.present === '1');
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
  res.redirect(`/main-admin/events/${req.params.id}/registrations`);
});

router.post('/:id/guests/:guestId/checkin', async (req, res) => {
  await events.setGuestCheckedIn(req.params.guestId, req.body.present === '1');
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
  res.redirect(`/main-admin/events/${req.params.id}/registrations`);
});

// Item 11 - explicit Check In / Check Out buttons (distinct from the
// Present/Clear toggle above) and a P/A/L status select, same shape as
// class check-in/out.
router.post('/:id/registrations/:regId/checkout', async (req, res) => {
  await events.setRegistrationCheckedOut(req.params.regId);
  res.redirect(`/main-admin/events/${req.params.id}/registrations`);
});

router.post('/:id/guests/:guestId/checkout', async (req, res) => {
  await events.setGuestCheckedOut(req.params.guestId);
  res.redirect(`/main-admin/events/${req.params.id}/registrations`);
});

router.post('/:id/registrations/:regId/status', async (req, res) => {
  await events.setRegistrationAttendanceStatus(req.params.regId, req.body.status);
  res.json({ ok: true });
});

router.post('/:id/guests/:guestId/status', async (req, res) => {
  await events.setGuestAttendanceStatus(req.params.guestId, req.body.status);
  res.json({ ok: true });
});

// Guest registration ("guest registration for events (admin permission)")
// - gated by register_guests on top of this whole router's own
// manage_events requirement, so a Main Admin has to be granted that
// specific extra permission to add a walk-in guest, even though they can
// already manage every other part of an event.
router.post('/:id/guests', requirePortalPermission('register_guests'), async (req, res) => {
  const guestName = (req.body.guestName || '').trim();
  if (!guestName) return res.redirect(`/main-admin/events/${req.params.id}/registrations?error=` + encodeURIComponent('Guest name is required.'));
  await events.addGuestRegistration(
    req.params.id,
    { guestName, guestEmail: (req.body.guestEmail || '').trim(), guestPhone: (req.body.guestPhone || '').trim() },
    req.portalAccount.id
  );
  res.redirect(`/main-admin/events/${req.params.id}/registrations?notice=` + encodeURIComponent('Guest registered.'));
});

router.post('/:id/guests/:guestId/cancel', requirePortalPermission('register_guests'), async (req, res) => {
  await events.cancelGuestRegistration(req.params.guestId);
  res.redirect(`/main-admin/events/${req.params.id}/registrations?notice=` + encodeURIComponent('Guest registration cancelled.'));
});

module.exports = router;
