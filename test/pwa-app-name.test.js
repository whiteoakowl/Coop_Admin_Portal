// Real bug report: "When downloading the app its labeled SH Check In.
// It should be labeled Co-op Admin Portal." public/manifest.json's
// name/short_name (Android/Chrome's own install label) and the
// apple-mobile-web-app-title meta tag (views/partials/head.ejs, iOS
// Safari's "Add to Home Screen" - often ignores the web manifest
// entirely) both need to agree on the same corrected name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `pwa-app-name-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `pwa-app-name-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('the PWA manifest names the app "Co-op Admin Portal", not "SH Check-In"', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Co-op Admin Portal');
  assert.equal(manifest.short_name, 'Co-op Admin Portal');
});

test('every page carries an apple-mobile-web-app-title meta tag with the same corrected name, for iOS Add to Home Screen', async () => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);
  assert.match(res.text, /<meta name="apple-mobile-web-app-title" content="Co-op Admin Portal" \/>/);
});
