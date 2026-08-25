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
const events = require('../utils/events');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_events'));

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
  res.render('admin-events-list', { title: 'Events', events: list, notice: req.query.notice || null });
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
    },
    req.portalAccount.id
  );
  res.redirect(`/main-admin/events/${id}/builder`);
});

async function loadBuilder(req, res) {
  const event = await events.getEventWithDetails(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-events-builder', {
    title: event.title,
    event,
    imageUrl: imageUrl(event.image_key),
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
  });
  res.redirect(`/main-admin/events/${id}/builder?notice=` + encodeURIComponent('Settings saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'published', 'cancelled'].includes(status)) return res.redirect(`/main-admin/events/${req.params.id}/builder`);
  await events.setEventStatus(req.params.id, status);
  res.redirect(`/main-admin/events/${req.params.id}/builder?notice=` + encodeURIComponent(`Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  await events.deleteEvent(req.params.id);
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

// --- Registrations (read-only report) ---

router.get('/:id/registrations', async (req, res) => {
  const event = await events.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const registrations = await events.registrationsForEvent(req.params.id);
  res.render('admin-events-registrations', { title: `Registrations - ${event.title}`, event, registrations });
});

module.exports = router;
