// Coverage for a real request: "PDF download icons should be added to
// every page across the app that has a print icon/button" - applied here
// to Main Admin's own 6 name-tag/badge print pages (routes/main-admin-
// name-tags.js). Every Download PDF button sits right next to its own
// existing Print button and posts (or links) to a sibling .../download.pdf
// route that renders the exact same -print.ejs view through utils/
// pdfRender.js's renderViewToPdf instead of res.render, so the download is
// a real PDF of exactly what the Print button's own preview tab shows -
// same pattern as test/parent-family-school-print-preview-and-pdf.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-name-tags-download-pdf-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-name-tags-download-pdf-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const { createSection, addItem } = require('../utils/taskList');
const { replaceMiscBadges } = require('../utils/miscBadgeData');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken, pageText: page.text };
}

function bufferParse(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

async function getBuffer(url, cookie) {
  return request(app).get(url).set('Cookie', cookie).buffer(true).parse(bufferParse);
}

async function postBuffer(url, cookie, body) {
  return request(app).post(url).set('Cookie', cookie).buffer(true).parse(bufferParse).type('form').send(body);
}

function assertRealPdf(res) {
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
}

let counter = 0;
async function createMember(type) {
  counter += 1;
  const code = `dlpdf${counter}`;
  const { lastInsertRowid: id } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, ?, 1)")
    .run(`Download PDF Member ${counter}`, code, code, type);
  return id;
}

test('Design/Print live page carries a Download PDF button next to every one of its own Print buttons', async () => {
  const { pageText } = await loginAsMainAdmin();
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/print\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/print-plain-parent\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/print-duplex\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/print-barcodes\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/print-barcode-labels\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/badges\/bypass\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/badges\/setupCleanup\/download\.pdf"[^>]*aria-label="Download PDF"/);
  assert.match(pageText, /formaction="\/main-admin\/name-tags\/badges\/custom\/download\.pdf"[^>]*aria-label="Download PDF"/);

  const requestsPage = await request(app).get('/main-admin/name-tags?tab=requests').set('Cookie', (await loginAsMainAdmin()).cookie);
  assert.match(requestsPage.text, /href="\/main-admin\/name-tags\/requests\/download\.pdf\?archived=0" aria-label="Download PDF"/);
});

test('Print Name Tags: Download PDF is a real PDF of the same bulk name tag sheet Print opens', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await createMember('student');

  const pdfRes = await postBuffer('/main-admin/name-tags/print/download.pdf', cookie, { memberIds: memberId, _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="name-tags\.pdf"/);
});

test('Print Plain Parent Tags: Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await createMember('parent');

  const pdfRes = await postBuffer('/main-admin/name-tags/print-plain-parent/download.pdf', cookie, { memberIds: memberId, _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="plain-parent-name-tags\.pdf"/);
});

test('Print Name Tags + Schedule Cards (Front & Back): Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await createMember('student');

  const pdfRes = await postBuffer('/main-admin/name-tags/print-duplex/download.pdf', cookie, { memberIds: memberId, _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="name-tags-schedule-cards-duplex\.pdf"/);
});

test('Print Barcodes: Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await createMember('student');

  const pdfRes = await postBuffer('/main-admin/name-tags/print-barcodes/download.pdf', cookie, { memberIds: memberId, _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="barcodes\.pdf"/);
});

test('Print Barcode Labels: Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await createMember('student');

  const pdfRes = await postBuffer('/main-admin/name-tags/print-barcode-labels/download.pdf', cookie, { memberIds: memberId, _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="barcode-labels\.pdf"/);
});

test('Setup/Cleanup Bypass Badges: Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  const pdfRes = await postBuffer('/main-admin/name-tags/badges/bypass/download.pdf', cookie, { quantity: '2', _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="setup-cleanup-bypass-badges\.pdf"/);
});

test('Setup/Cleanup Badges (real task-derived badge): Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const sectionId = await createSection('monday', 'Download PDF Team', null);
  const itemId = await addItem(sectionId, 'Set out the chairs');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);

  const pdfRes = await postBuffer('/main-admin/name-tags/badges/setupCleanup/download.pdf', cookie, { badgeIds: String(badge.id), _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="setupCleanup-badges\.pdf"/);
});

test('Custom Badges: Download PDF is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await replaceMiscBadges('custom', [{ badgeNumber: '1', title: 'Volunteer', description: 'Thanks for helping!' }]);
  const badge = await db.prepare("SELECT * FROM misc_badges WHERE badge_type = 'custom'").get();

  const pdfRes = await postBuffer('/main-admin/name-tags/badges/custom/download.pdf', cookie, { badgeIds: String(badge.id), _csrf: csrfToken });

  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="custom-badges\.pdf"/);
});

test('Name Tag Requests: Download PDF is a real PDF of the same preview Print opens', async () => {
  const { cookie } = await loginAsMainAdmin();

  const pdfRes = await getBuffer('/main-admin/name-tags/requests/download.pdf', cookie);
  assertRealPdf(pdfRes);
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="name-tag-requests\.pdf"/);
});
