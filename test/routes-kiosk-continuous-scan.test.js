// Real request: "when members are scanning that don't need to scan a
// setup/cleanup badge, they should be able to continuously scan. there
// is a button that says done. have a great day! message pops up and
// goes back to kiosk homepage screen." Both kiosk-checkin.ejs and
// kiosk-checkout.ejs's own step-scan panel now render a #done-btn
// alongside the scan form - the actual continuous-scan/redirect timing
// itself lives in public/js/kiosk-checkin.js and kiosk-checkout.js (a
// browser-only setTimeout flow, verified by hand via Playwright rather
// than unit-tested here, same as every other kiosk client script in this
// app), so this just locks down the markup those scripts depend on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `kiosk-continuous-scan-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `kiosk-continuous-scan-test-uploads-${process.pid}`);
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

for (const [label, url] of [
  ['Check In', '/kiosk/checkin'],
  ['Check Out', '/kiosk/checkout'],
]) {
  test(`${label} kiosk page's step-scan panel has a Done button alongside the scan form`, async () => {
    const res = await request(app).get(url);
    assert.equal(res.status, 200);
    const stepScanMatch = /<div id="step-scan" class="kiosk-panel">([\s\S]*?)<\/div>\s*<!--/.exec(res.text);
    assert.ok(stepScanMatch, 'expected a #step-scan panel');
    assert.match(stepScanMatch[1], /<button id="done-btn" type="button" class="kiosk-done-btn">Done<\/button>/);
    assert.match(res.text, /<script src="\/js\/kiosk-common\.js">/, 'sanity: this is the real kiosk scan page, not a stub');
  });
}
