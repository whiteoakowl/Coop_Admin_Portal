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
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, publicUrl, generateKey } = require('../utils/storage');
const { formatFriendlyTimestamp } = require('../utils/dates');
const db = require('../db');
const events = require('../utils/events');
const auditLog = require('../utils/auditLog');
const { findMemberByBarcodeOrName } = require('../utils/memberLookup');

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

router.get('/', async (req, res) => {
  const list = await events.listEvents();
  const pendingCount = list.filter((e) => e.approval_status === 'pending').length;
  res.render('admin-events-list', { title: 'Events', events: list, pendingCount, notice: req.query.notice || null });
});

router.get('/categories', async (req, res) => {
  res.render('admin-events-categories', { title: 'Event Categories', categories: await events.listCategories(), notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/categories', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/events/categories?error=' + encodeURIComponent('Category name is required.'));
  await events.createCategory(name, req.body.color);
  res.redirect('/main-admin/events/categories?notice=' + encodeURIComponent('Category added.'));
});

router.post('/categories/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/events/categories?error=' + encodeURIComponent('Category name is required.'));
  await events.updateCategory(req.params.id, name, req.body.color);
  res.redirect('/main-admin/events/categories?notice=' + encodeURIComponent('Category updated.'));
});

router.post('/categories/:id/delete', async (req, res) => {
  await events.deleteCategory(req.params.id);
  res.redirect('/main-admin/events/categories?notice=' + encodeURIComponent('Category removed.'));
});

// Member-submitted events awaiting a Main Admin's yes/no ("members should
// be able to add events for approval") - a decision doesn't publish the
// event, it only clears approval_status so the submitter's own event now
// shows up in the regular events list/builder like any admin-created one,
// still starting 'draft' until a Main Admin actually chooses to publish it.
router.get('/pending', async (req, res) => {
  const pending = await events.listEvents({ approvalStatus: 'pending' });
  res.render('admin-events-pending', {
    title: 'Submitted Events',
    pending: pending.map((e) => ({ ...e, startsLabel: formatFriendlyTimestamp(e.starts_at) })),
    notice: req.query.notice || null,
  });
});

router.post('/:id/decide', async (req, res) => {
  const approve = req.body.decision === 'approve';
  const result = await events.decideSubmission(req.params.id, approve);
  if (!result) return res.redirect('/main-admin/events/pending?notice=' + encodeURIComponent('That submission was already decided.'));
  res.redirect('/main-admin/events/pending?notice=' + encodeURIComponent(`Submission ${result}.`));
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
      description: (req.body.description || '').trim(),
      category: (req.body.category || '').trim(),
      location: (req.body.location || '').trim(),
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

async function loadBuilder(req, res) {
  const event = await events.getEventWithDetails(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-events-builder', {
    title: event.title,
    event,
    imageUrl: imageUrl(event.image_key),
    categories: await events.listCategories(),
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
    description: (req.body.description || '').trim(),
    category: (req.body.category || '').trim(),
    location: (req.body.location || '').trim(),
    startsAt,
    endsAt: toSqlTimestamp(req.body.endsAt),
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
    capacity: req.body.capacity ? parseInt(req.body.capacity, 10) : null,
    ...registrationFieldsFromBody(req.body),
  });
  await events.setEventSections(id, req.body.sectionIds);
  res.redirect(`/main-admin/events/${id}/builder?notice=` + encodeURIComponent('Settings saved.'));
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
