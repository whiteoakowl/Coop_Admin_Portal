// Real HTTP-level coverage for the Edit Event Image upload (a real bug
// report: "it still says something went wrong trying to upload a
// photo"). Root cause: routes/admin-events.js's upload.single('image')
// middleware had no LIMIT_FILE_SIZE handling of its own - a too-large
// file made multer throw a MulterError that fell all the way through to
// server.js's generic catch-all error handler and rendered the generic
// 500 page ("Something went wrong") instead of a friendly redirect, the
// same bug class already fixed for routes/admin-documents.js's own
// uploadDocument and utils/memberIntake.js's own uploadIntakePhotos - see
// routes/admin-events.js's own uploadEventImage for the matching fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-events-image-upload-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-events-image-upload-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createEvent(admin) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Image Upload Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

test('POST /main-admin/events/:id/image with a file over the 5MB limit redirects with a friendly error, not a 500', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const oversized = Buffer.alloc(6 * 1024 * 1024, 'a');
  const res = await request(app)
    .post(`/main-admin/events/${eventId}/image?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .attach('image', oversized, { filename: 'huge.jpg', contentType: 'image/jpeg' });

  assert.equal(res.status, 302, 'a too-large image should redirect back to the builder, not crash into a 500');
  assert.match(res.headers.location, new RegExp(`/main-admin/events/${eventId}/builder`));
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /too large/i);
  assert.match(notice, /5MB/);

  const event = await db.prepare('SELECT image_key FROM events WHERE id = ?').get(eventId);
  assert.equal(event.image_key, null, 'the oversized upload should never be recorded');
});

test('POST /main-admin/events/:id/image with a real small image succeeds and shows on the Details tab', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const res = await request(app)
    .post(`/main-admin/events/${eventId}/image?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .attach('image', Buffer.from('fake jpeg bytes'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);
  assert.doesNotMatch(res.headers.location, /error=/);

  const event = await db.prepare('SELECT image_key FROM events WHERE id = ?').get(eventId);
  assert.ok(event.image_key, 'the event should now have an image_key');

  const builder = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.match(builder.text, /data-event-image-preview/);
  assert.match(builder.text, new RegExp(event.image_key));
});

test('POST /main-admin/events/:id/image with no file redirects with the existing "please choose an image" error', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const res = await request(app)
    .post(`/main-admin/events/${eventId}/image`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });

  assert.equal(res.status, 302);
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /choose an image/i);
});

// A real request: "uploading image should have an upload button to the
// right of choose file" and "after you hit upload photo button it
// should show the image before saving" - the Event Image control is now
// its own separate <form> from the big Details save (an HTML form can't
// nest inside another), posting straight to /:id/image, so saving Details
// no longer touches the image at all.
test('saving Event Details (no file attached) never touches the event image', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/image?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .attach('image', Buffer.from('fake jpeg bytes'), { filename: 'photo.jpg', contentType: 'image/jpeg' });
  const before = await db.prepare('SELECT image_key FROM events WHERE id = ?').get(eventId);

  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Renamed Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });

  const after = await db.prepare('SELECT title, image_key FROM events WHERE id = ?').get(eventId);
  assert.equal(after.title, 'Renamed Event');
  assert.equal(after.image_key, before.image_key, 'the image should be unaffected by a Details save');
});

// A real request: "upload photo button should be smaller, fit to text
// and sit clean next to choose file bar" and "save event details button
// should be the very last button on the page and dark blue, like we
// used on other pages."
test('Details tab: Upload button is fit-to-text, Save Event Details is the last button and dark blue', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);

  assert.match(page.text, /<form method="POST" action="\/main-admin\/events\/\d+\/image" enctype="multipart\/form-data" class="roster-btn-row">[\s\S]*?<button type="submit" class="roster-action-btn" style="flex: 0 0 auto; min-width: 0;">Upload<\/button>/);

  // The Save button lives outside the Details <form> (an HTML form can't
  // nest inside another) but is still linked to it via form=, and it's
  // physically the last button in the Details tab - after the Image
  // section, not inside the big form above it.
  const detailsTabHtml = page.text.slice(page.text.indexOf('id="details-form"'));
  const imageFormIndex = detailsTabHtml.indexOf('/image" enctype="multipart/form-data"');
  const saveButtonIndex = detailsTabHtml.indexOf('Save Event Details');
  assert.ok(imageFormIndex > -1 && saveButtonIndex > imageFormIndex, 'Save Event Details should come after the Image upload section');
  assert.match(detailsTabHtml.slice(saveButtonIndex - 200, saveButtonIndex + 50), /<button type="submit" form="details-form" class="primary-btn primary-btn-dark">Save Event Details<\/button>/);

  // Still submits the Details form correctly despite living outside it.
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Moved Save Button Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  const event = await db.prepare('SELECT title FROM events WHERE id = ?').get(eventId);
  assert.equal(event.title, 'Moved Save Button Event');
});
