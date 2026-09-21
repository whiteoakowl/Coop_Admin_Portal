// A real request: "main admin, events, settings, calendar view and list
// view should be on the same row... allow and disallow options should
// all be in the same row as well and yes and no. remove make events
// members create public by default. new settings, automatically issue
// refund if member cancels their registration. add/edit categories,
// add/edit locations buttons should be at the top of the page. remove
// export and import buttons from the event settings page."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-settings-layout-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-settings-layout-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('Events Settings tab: Add/Edit Category & Location buttons at the top, Export/Import gone, yes/no questions are a single checkbox column', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // Export/Import buttons live in the page's top toolbar for every other
  // tab, but not Settings.
  assert.doesNotMatch(res.text, /href="\/main-admin\/events\/export\.csv"/);
  assert.doesNotMatch(res.text, /id="import-events-dialog"\).showModal/);

  // Add/Edit Category and Add/Edit Location now come before <h2>General Settings</h2>.
  const categoryBtnIndex = res.text.indexOf('Add/Edit Category');
  const locationBtnIndex = res.text.indexOf('Add/Edit Location');
  const headingIndex = res.text.indexOf('<h2>General Settings</h2>');
  assert.ok(categoryBtnIndex > -1 && categoryBtnIndex < headingIndex, 'Add/Edit Category should sit above General Settings');
  assert.ok(locationBtnIndex > -1 && locationBtnIndex < headingIndex, 'Add/Edit Location should sit above General Settings');

  // Calendar/List View radios share one .checkbox-group row.
  const calendarViewGroup = /Default Calendar User View<\/span>\s*<div class="checkbox-group">([\s\S]*?)<\/div>/.exec(res.text);
  assert.ok(calendarViewGroup, 'expected a checkbox-group wrapping the Calendar/List View radios');
  assert.match(calendarViewGroup[1], /Calendar View/);
  assert.match(calendarViewGroup[1], /List View/);

  // A real request: "event settings, all questions should be check
  // boxes. the check boxes should be in a single uniform column on the
  // left and the question begins on the same row as the check box." Every
  // former Allow/Do not allow and Yes/No radio pair (that's genuinely
  // binary, not the 3-way family-submission or Calendar/List view choice)
  // is now one checkbox, all sharing a single .checkbox-group-stack column.
  const stackGroup = /<div class="member-form-full checkbox-group checkbox-group-stack">([\s\S]*?)<\/div>\s*<\/div>/.exec(res.text);
  assert.ok(stackGroup, 'expected a single stacked checkbox-group column for the yes/no questions');
  const checkboxCount = (stackGroup[1].match(/type="checkbox"/g) || []).length;
  assert.ok(checkboxCount >= 8, `expected at least 8 checkboxes in the stacked column, found ${checkboxCount}`);
  assert.doesNotMatch(stackGroup[1], /type="radio"/, 'the stacked yes/no questions should be checkboxes, not radios');

  // "Make events public by default" is gone entirely.
  assert.doesNotMatch(res.text, /Make events submitted by families public by default/);
  assert.doesNotMatch(res.text, /familyEventsPublicDefault/);

  // The new auto-refund setting is present as a single checkbox.
  assert.match(res.text, /Automatically issue a refund if a member cancels their registration\?/);
  assert.match(res.text, /name="autoRefundOnFamilyCancel" value="1"/);
  assert.doesNotMatch(res.text, /name="autoRefundOnFamilyCancel" value="0"/);
});

test('saving Settings persists the new auto-refund setting', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/events/settings')
    .set('Cookie', cookie)
    .type('form')
    .send({
      defaultCalendarView: 'calendar',
      reminderDaysBefore: '10',
      autoRefundOnFamilyCancel: '1',
      familySubmitEvents: 'yes',
      _csrf: csrf,
    });

  const row = await db.prepare('SELECT auto_refund_on_family_cancel FROM event_settings WHERE id = 1').get();
  assert.equal(row.auto_refund_on_family_cancel, 1);

  const after = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  assert.match(after.text, /name="autoRefundOnFamilyCancel" value="1" checked/);
  assert.doesNotMatch(after.text, /name="autoRefundOnFamilyCancel" value="0"/);
});

test('a family-submitted event keeps its own chosen visibility, even if the legacy public-by-default column is still true in the database', async () => {
  const cookie = await loginAsMainAdmin();
  const csrf = extractCsrf((await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie)).text);
  await request(app)
    .post('/main-admin/events/settings')
    .set('Cookie', cookie)
    .type('form')
    .send({ defaultCalendarView: 'calendar', reminderDaysBefore: '10', familySubmitEvents: 'yes', _csrf: csrf });
  // updateEventSettings no longer writes family_events_public_default -
  // force it true directly to simulate a pre-existing row where an admin
  // had once turned it on, before the setting was removed.
  await db.prepare('UPDATE event_settings SET family_events_public_default = 1 WHERE id = 1').run();

  const events = require('../utils/events');
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Submit Visibility Family')).lastInsertRowid;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'parent', ?, 1)")
      .run('Submit Visibility Parent', 'submit-vis-parent', familyId)
  ).lastInsertRowid;
  const accountId = (
    await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, 'x', 'active')").run(memberId, 'submit-vis@example.com')
  ).lastInsertRowid;

  const eventId = await events.submitEvent({ title: 'Visibility Test Event', startsAt: '2027-05-01T10:00', visibility: 'members' }, accountId);
  const created = await events.getEvent(eventId);
  assert.equal(created.visibility, 'members', "submitEvent should keep the submitter's own visibility choice, not force public");
});
