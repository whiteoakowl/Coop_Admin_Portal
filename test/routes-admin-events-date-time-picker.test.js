// Coverage for Event Details' Starts/Ends fields (views/admin-events-
// builder.ejs) - a real request: "date picker should be a calendar. Start
// and end time should be separate drop down menus." Replaces the single
// datetime-local input with a calendar <input type="date"> plus a time-of-
// day <select> (partials/time-select.ejs), recombined client-side
// (public/js/event-date-time-picker.js) into the same hidden startsAt/
// endsAt "YYYY-MM-DDTHH:MM" value the POST route has always expected - so
// this only tests the GET-rendered markup, not the save route itself
// (already covered by every other admin-events test that posts a literal
// startsAt string).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-events-date-time-picker-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-events-date-time-picker-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function createEvent(admin, startsAt, endsAt) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Date Time Picker Event', startsAt, endsAt: endsAt || '', _csrf: admin.csrfToken });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

test('Details tab: Starts/Ends render as a calendar date input plus a time-of-day dropdown, not datetime-local', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, '2027-09-01T18:15', '2027-09-01T20:30');
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  assert.doesNotMatch(page.text, /type="datetime-local"/, 'no datetime-local input left on the Details tab');

  assert.match(page.text, /<input type="date" data-date-time-date data-date-time-group="starts" value="2027-09-01" required \/>/);
  assert.match(page.text, /<select data-date-time-time data-date-time-group="starts" required>/);
  assert.match(page.text, /<option value="18:15" selected>6:15 PM<\/option>/);
  assert.match(page.text, /<input type="hidden" name="startsAt" data-date-time-hidden="starts" value="2027-09-01T18:15" \/>/);

  assert.match(page.text, /<input type="date" data-date-time-date data-date-time-group="ends" value="2027-09-01"[^>]* \/>/);
  assert.match(page.text, /<option value="20:30" selected>8:30 PM<\/option>/);
  assert.match(page.text, /<input type="hidden" name="endsAt" data-date-time-hidden="ends" value="2027-09-01T20:30" \/>/);

  assert.match(page.text, /<script src="\/js\/event-date-time-picker\.js"><\/script>/);
});

test('a legacy event with an off-grid minute (not on a 15-minute boundary) still gets its exact time as a selectable, selected option', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, '2027-09-01T09:07');
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(page.text, /<option value="09:07" selected>9:07 AM<\/option>/);
});

test('an event with no end time renders the Ends date/time controls empty, not pre-filled', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, '2027-09-01T09:00');
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(page.text, /<input type="date" data-date-time-date data-date-time-group="ends" value=""[^>]* \/>/);
  assert.match(page.text, /<input type="hidden" name="endsAt" data-date-time-hidden="ends" value="" \/>/);
});

// A real request: "start date and end date picker should be on the same
// row next to each other. Stacked below start time and end time clock
// picker in the same row next to each other." Start/End Date share one
// row, Start/End Time share a separate row stacked below it - not each
// field's own date+time pair together.
test('Details tab: Start Date/End Date share one row, Start Time/End Time share a separate row below it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, '2027-09-01T18:15', '2027-09-01T20:30');
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);

  const dateRowMatch = /<div class="member-form-full date-time-two-col-row">\s*<label>Start Date([\s\S]*?)<\/div>/.exec(page.text);
  assert.ok(dateRowMatch, 'expected a Dates row starting with Start Date');
  assert.match(dateRowMatch[1], /End Date/);
  assert.match(dateRowMatch[1], /data-date-time-group="starts"/);
  assert.match(dateRowMatch[1], /data-date-time-group="ends"/);
  assert.doesNotMatch(dateRowMatch[1], /data-date-time-time/, 'the Dates row should contain no time <select>');

  const timeRowMatch = /<div class="member-form-full date-time-two-col-row">\s*<label>Start Time([\s\S]*?)<\/div>/.exec(page.text);
  assert.ok(timeRowMatch, 'expected a Times row starting with Start Time');
  assert.match(timeRowMatch[1], /End Time/);
  assert.match(timeRowMatch[1], /data-date-time-time data-date-time-group="starts"/);
  assert.match(timeRowMatch[1], /data-date-time-time data-date-time-group="ends"/);
  assert.doesNotMatch(timeRowMatch[1], /data-date-time-date/, 'the Times row should contain no date input');

  assert.ok(dateRowMatch.index < timeRowMatch.index, 'the Dates row should come before the Times row');
});
