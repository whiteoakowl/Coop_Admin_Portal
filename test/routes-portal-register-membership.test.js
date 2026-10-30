// Coverage for the public self-registration form (routes/portal-auth.js's
// GET/POST /register, views/portal-register.ejs) - a real request: "there
// should be a place at the bottom of the membership application to check
// a box after reading the policy handbook... can't submit application
// without checking the box." The client-side scroll-gating (public/js/
// portal-register-form.js disables the checkbox until scrolled to the
// bottom) isn't testable at the route level, but the server-side
// re-check (a disabled attribute is only ever a client-side nicety) is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-register-membership-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-register-membership-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const membershipHandbook = require('../utils/membershipHandbook');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

function baseRegistration(overrides) {
  return {
    firstName: 'Pat',
    lastName: 'Applicant',
    email: 'pat.applicant@example.com',
    password: 'testpassword123',
    confirmPassword: 'testpassword123',
    handbookRead: '1',
    privacyPolicyRead: '1',
    termsRead: '1',
    ...overrides,
  };
}

test('GET /register renders the admin-set Policy Handbook and payment info', async () => {
  await membershipHandbook.setHandbookHtml('<p>Read this whole handbook.</p>');
  await membershipHandbook.setPaymentInfo(15000, 'Pay by check once approved.');

  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.match(res.text, /Read this whole handbook/);
  assert.match(res.text, /150\.00/);
  assert.match(res.text, /Pay by check once approved/);
});

test('POST /register without handbookRead=1 is rejected, no account created', async () => {
  const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get()).c);
  const res = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ handbookRead: undefined, email: 'no-handbook@example.com' }));
  assert.equal(res.status, 200);
  assert.match(res.text, /Policy Handbook/);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get()).c), before);
});

test('POST /register with handbookRead=1 succeeds, creating a pending account', async () => {
  const res = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ email: 'handbook-confirmed@example.com' }));
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const account = await db.prepare("SELECT status FROM member_accounts WHERE email = 'handbook-confirmed@example.com'").get();
  assert.ok(account, 'expected a member_accounts row to be created');
  assert.equal(account.status, 'pending');
});

// Coverage for a real Telnyx 10DLC campaign review rejection: "add a
// link/screenshot of the opt-in form... showing the phone number field
// and full SMS opt-in language" - /register had neither until now.
test('GET /register shows a phone field, an unchecked SMS opt-in checkbox, and a link to the Privacy Policy', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="phone"/);
  assert.match(res.text, /name="smsOptIn"/);
  assert.doesNotMatch(res.text, /name="smsOptIn"[^>]*checked/, 'the SMS opt-in checkbox must be unchecked by default');
  assert.match(res.text, /href="\/privacy-policy"/);
  assert.match(res.text, /Reply STOP/);
  assert.match(res.text, /<input type="tel" id="register-phone-input" name="phone"/);
  assert.match(res.text, /<script src="\/js\/portal-register-form\.js">/);
});

// A later real request trimmed the SMS paragraph down and moved its
// Privacy Policy/Terms and Conditions link into its own required
// checkboxes: "Remove msg and data rate may apply. Remove see our at
// the end. Remove optional wording message. Remove texting: enter your
// phone number above. Next section. Privacy Policy with a check box,
// next row terms and conditions with checkbox."
test('GET /register has a trimmed SMS paragraph and its own required Privacy Policy/Terms and Conditions checkboxes', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Msg &amp; data rates may apply/);
  assert.doesNotMatch(res.text, /See our/);
  assert.doesNotMatch(res.text, /Optional - you can still register without opting in to SMS/);
  assert.doesNotMatch(res.text, /sms-opt-in-phone-echo/);
  assert.match(res.text, /<input type="checkbox" name="privacyPolicyRead" value="1" required \/>/);
  assert.match(res.text, /<input type="checkbox" name="termsRead" value="1" required \/>/);
  assert.match(res.text, /I have read and agree to the <a href="\/privacy-policy" target="_blank">Privacy Policy<\/a>\./);
  assert.match(res.text, /I have read and agree to the <a href="\/terms-and-conditions" target="_blank">Terms and Conditions<\/a>\./);
});

// A real request: "Policy handbook should be after sms message."
test('GET /register places the Policy Handbook section right after SMS Notifications, before Privacy Policy & Terms and Conditions', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  const smsIdx = res.text.indexOf('>SMS Notifications<');
  const handbookIdx = res.text.indexOf('>Policy Handbook<');
  const privacyIdx = res.text.indexOf('>Privacy Policy &amp; Terms and Conditions<');
  assert.ok(smsIdx !== -1 && handbookIdx !== -1 && privacyIdx !== -1);
  assert.ok(smsIdx < handbookIdx && handbookIdx < privacyIdx, 'Policy Handbook must sit between SMS Notifications and Privacy Policy & Terms and Conditions');
});

test('POST /register without checking the Privacy Policy or Terms and Conditions boxes is rejected', async () => {
  const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get()).c);
  const noPrivacyRes = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ privacyPolicyRead: undefined, email: 'no-privacy@example.com' }));
  assert.equal(noPrivacyRes.status, 200);
  assert.match(noPrivacyRes.text, /Privacy Policy/);
  assert.doesNotMatch(noPrivacyRes.text, /Registration Submitted/);

  const noTermsRes = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ termsRead: undefined, email: 'no-terms@example.com' }));
  assert.equal(noTermsRes.status, 200);
  assert.match(noTermsRes.text, /Terms and Conditions/);
  assert.doesNotMatch(noTermsRes.text, /Registration Submitted/);

  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get()).c), before);
});

// A real request: "At the bottom of the parent guardian section should
// be the add portal password option" - no more separate "Account Login"
// section further down the page.
test('GET /register has the password fields inside the Parent/Guardian section, with no separate Account Login section', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, />Account Login</);
  const parentSectionIdx = res.text.indexOf('>Parent / Guardian<');
  const additionalParentsIdx = res.text.indexOf('>Additional Parents / Guardians<');
  const passwordIdx = res.text.indexOf('name="password"');
  const confirmPasswordIdx = res.text.indexOf('name="confirmPassword"');
  assert.ok(parentSectionIdx !== -1 && passwordIdx !== -1 && confirmPasswordIdx !== -1 && additionalParentsIdx !== -1);
  assert.ok(
    parentSectionIdx < passwordIdx && passwordIdx < confirmPasswordIdx && confirmPasswordIdx < additionalParentsIdx,
    'Password/Confirm Password must sit at the bottom of the Parent/Guardian section, before Additional Parents/Guardians'
  );
});

test('POST /register without checking SMS opt-in saves the phone number but leaves sms_consent false', async () => {
  const res = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ email: 'no-sms-optin@example.com', phone: '555-111-2222' }));
  assert.equal(res.status, 200);

  const member = await db.prepare("SELECT phone, sms_consent, sms_consent_at FROM members WHERE email = 'no-sms-optin@example.com'").get();
  assert.ok(member, 'expected a members row to be created');
  assert.equal(member.phone, '555-111-2222');
  assert.equal(!!member.sms_consent, false);
  assert.equal(member.sms_consent_at, null);
});

test('POST /register with smsOptIn=1 records sms_consent and a consent timestamp', async () => {
  const res = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ email: 'sms-optin@example.com', phone: '555-333-4444', smsOptIn: '1' }));
  assert.equal(res.status, 200);

  const member = await db.prepare("SELECT phone, sms_consent, sms_consent_at FROM members WHERE email = 'sms-optin@example.com'").get();
  assert.ok(member, 'expected a members row to be created');
  assert.equal(member.phone, '555-333-4444');
  assert.equal(!!member.sms_consent, true);
  assert.ok(member.sms_consent_at, 'expected a consent timestamp to be recorded');
});

test('GET /privacy-policy is public and includes the required SMS data-sharing disclosure', async () => {
  const res = await request(app).get('/privacy-policy');
  assert.equal(res.status, 200);
  assert.match(res.text, /Privacy Policy/);
  assert.match(res.text, /will not be sold or shared with third parties for promotional or marketing purposes/i);
});

// A real request: the "Request Membership Form" quick link under Main
// Admin's own Settings hub always bounced to the portal picker instead
// of showing the form, since clicking it necessarily happens while
// logged in as Main Admin.
test('GET /register shows the actual form for a logged-in Main Admin instead of bouncing to the portal picker', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/register').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Request Membership/);
  assert.match(res.text, /name="phone"/);
});

test('GET /register still redirects a logged-in parent (not Main Admin) to the portal picker', async () => {
  const registerRes = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ email: 'already-registered@example.com' }));
  assert.match(registerRes.text, /Registration Submitted/);
  await db.prepare("UPDATE member_accounts SET status = 'active' WHERE email = 'already-registered@example.com'").run();

  const loginRes = await request(app).post('/login').type('form').send({ email: 'already-registered@example.com', password: 'testpassword123', next: '/portal' });
  const cookie = loginRes.headers['set-cookie'];
  const registerPageRes = await request(app).get('/register').set('Cookie', cookie);
  assert.equal(registerPageRes.status, 302);
  assert.equal(registerPageRes.headers.location, '/portal');
});

test('GET /terms-and-conditions is public and GET /register links to both it and the Privacy Policy', async () => {
  const res = await request(app).get('/terms-and-conditions');
  assert.equal(res.status, 200);
  assert.match(res.text, /Terms and Conditions/);

  const registerRes = await request(app).get('/register');
  assert.match(registerRes.text, /href="\/terms-and-conditions"/);
  assert.match(registerRes.text, /href="\/privacy-policy"/);
});
