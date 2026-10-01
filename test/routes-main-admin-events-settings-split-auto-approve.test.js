// A real request: "Main admin, events, settings, under allow families to
// submit events calendar events? It should just say yes or no.
// Automatically approve event member submit, yes or no, should be it's
// own question." The old event_settings.family_submit_events 3-way
// Yes/Auto-Approve/No radio is now two independent yes/no checkboxes:
// familySubmitEvents (family_submit_events: 'yes'/'no') and
// autoApproveFamilySubmissions (its own boolean column).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-settings-split-auto-approve-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-settings-split-auto-approve-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const events = require('../utils/events');

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

test('Events Settings tab renders two plain yes/no checkboxes, not a 3-way radio', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Automatically Approve<\/label>/, 'no more 3-way radio option text');
  assert.match(res.text, /<input type="checkbox" name="familySubmitEvents" value="1"[^>]*\/> Allow families to submit calendar of events items\?/);
  assert.match(res.text, /<input type="checkbox" name="autoApproveFamilySubmissions" value="1"[^>]*\/> Automatically approve event member submissions\?/);
});

test('saving Settings persists both yes/no questions independently', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/events/settings')
    .set('Cookie', cookie)
    .type('form')
    .send({ defaultCalendarView: 'calendar', reminderDaysBefore: '10', familySubmitEvents: '1', autoApproveFamilySubmissions: '1', _csrf: csrf });

  let row = await db.prepare('SELECT family_submit_events, auto_approve_family_submissions FROM event_settings WHERE id = 1').get();
  assert.equal(row.family_submit_events, 'yes');
  assert.equal(Number(row.auto_approve_family_submissions), 1);

  const afterBoth = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  assert.match(afterBoth.text, /name="familySubmitEvents" value="1" checked/);
  assert.match(afterBoth.text, /name="autoApproveFamilySubmissions" value="1" checked/);

  // Allow submissions but leave auto-approve off - the two questions move
  // independently of each other, which the old bundled radio could never do.
  const csrf2 = extractCsrf(afterBoth.text);
  await request(app)
    .post('/main-admin/events/settings')
    .set('Cookie', cookie)
    .type('form')
    .send({ defaultCalendarView: 'calendar', reminderDaysBefore: '10', familySubmitEvents: '1', _csrf: csrf2 });

  row = await db.prepare('SELECT family_submit_events, auto_approve_family_submissions FROM event_settings WHERE id = 1').get();
  assert.equal(row.family_submit_events, 'yes');
  assert.equal(Number(row.auto_approve_family_submissions), 0, 'leaving the auto-approve checkbox unchecked must turn it off');
});

test('submitEvent is gated by familySubmitEvents and separately by autoApproveFamilySubmissions', async (t) => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Split Settings Family') RETURNING id").get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES ('Split Settings Parent', 'split-settings-parent', 'parent', ?, 1, 1) RETURNING id")
      .get(familyId)
  ).id;
  const parentAcctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, 'split-settings@example.com', 'x', 'active', now_text()) RETURNING id")
      .get(memberId)
  ).id;
  const startsAt = (await db.prepare("SELECT to_char(now() + interval '5 days', 'YYYY-MM-DD HH24:MI:SS') AS t").get()).t;

  await t.test('familySubmitEvents off blocks submission entirely, even with auto-approve on', async () => {
    await request(app)
      .post('/main-admin/events/settings')
      .set('Cookie', cookie)
      .type('form')
      .send({ defaultCalendarView: 'calendar', reminderDaysBefore: '10', autoApproveFamilySubmissions: '1', _csrf: csrf });

    const result = await events.submitEvent({ title: 'Blocked Submission', startsAt, visibility: 'members' }, parentAcctId);
    assert.equal(result, null);
  });

  await t.test('familySubmitEvents on, autoApprove off: submission is created but stays pending', async () => {
    const csrf2 = extractCsrf((await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie)).text);
    await request(app)
      .post('/main-admin/events/settings')
      .set('Cookie', cookie)
      .type('form')
      .send({ defaultCalendarView: 'calendar', reminderDaysBefore: '10', familySubmitEvents: '1', _csrf: csrf2 });

    const eventId = await events.submitEvent({ title: 'Pending Submission', startsAt, visibility: 'members' }, parentAcctId);
    assert.ok(eventId);
    const ev = await events.getEvent(eventId);
    assert.equal(ev.approval_status, 'pending');
  });

  await t.test('familySubmitEvents on, autoApprove on: submission is auto-approved', async () => {
    const csrf3 = extractCsrf((await request(app).get('/main-admin/events?tab=settings').set('Cookie', cookie)).text);
    await request(app)
      .post('/main-admin/events/settings')
      .set('Cookie', cookie)
      .type('form')
      .send({ defaultCalendarView: 'calendar', reminderDaysBefore: '10', familySubmitEvents: '1', autoApproveFamilySubmissions: '1', _csrf: csrf3 });

    const eventId = await events.submitEvent({ title: 'Auto Approved Submission', startsAt, visibility: 'members' }, parentAcctId);
    assert.ok(eventId);
    const ev = await events.getEvent(eventId);
    assert.equal(ev.approval_status, 'approved');
  });
});
