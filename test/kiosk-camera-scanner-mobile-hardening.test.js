// A real bug report: "mobile barcode scan doesn't work on all mobile
// devices... make sure it works on all mobile devices no matter the age
// for all mobile check in types, attendance, class attendance, events
// etc." public/js/kiosk-camera-scanner.js backs every one of those
// (Class Check-In & Out, Find a Parent, Events Check-In, Orientation
// Check-In all create their own instance of it), so a fix there applies
// everywhere the feature exists at once. This can't exercise a real
// camera/getUserMedia prompt in this harness (no browser here at all),
// but the three concrete gaps the fix closes were each verified live in
// a real Chromium browser via Playwright: (1) no navigator.mediaDevices
// at all (an insecure http:// context, or a genuinely unsupported old
// browser) now gives a specific, actionable message instead of either a
// generic failure or - before this fix - an uncaught synchronous
// TypeError that could silently break the whole kiosk screen; (2) a
// double-tap/duplicate start() call before a first attempt finished used
// to risk two concurrent getUserMedia requests, which real mobile camera
// hardware very often refuses outright (unlike desktop) - confirmed the
// second start() now always stops the first reader before requesting a
// new stream; (3) every getUserMedia failure used to collapse into one
// generic "could not start the camera" message regardless of cause.
// This file asserts the source-level contract those fixes depend on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'kiosk-camera-scanner.js'), 'utf8');

test('checks navigator.mediaDevices/getUserMedia support before attempting to start', () => {
  assert.match(src, /navigator\.mediaDevices\s*\|\|\s*!navigator\.mediaDevices\.getUserMedia/);
});

test('distinguishes an insecure (non-https) context from a genuinely unsupported browser in its error message', () => {
  assert.match(src, /isSecureContext/);
  assert.match(src, /secure \(https:\/\/\) connection/i);
});

test('start() always stops any previous attempt first, so a double-call never leaves two concurrent camera requests', () => {
  const startIdx = src.indexOf('function start()');
  assert.ok(startIdx >= 0, 'expected a start() function');
  const afterStart = src
    .slice(startIdx)
    .split('\n')
    .slice(1) // drop the `function start() {` line itself
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
  assert.equal(afterStart[0], 'stop();', `expected start()'s first real statement to be stop(), got: ${afterStart[0]}`);
});

test('the whole start() attempt is wrapped so a synchronous throw (e.g. no Map support) cannot escape as an uncaught exception', () => {
  assert.match(src, /try\s*\{[\s\S]*new Map\(\)[\s\S]*?\}\s*catch/);
});

test('distinguishes permission-denied, no-camera, camera-in-use, and unsupported-constraints errors with their own messages', () => {
  assert.match(src, /NotAllowedError/);
  assert.match(src, /NotFoundError/);
  assert.match(src, /NotReadableError/);
  assert.match(src, /OverconstrainedError/);
});

test('every real check-in surface using Mobile Barcode Scan loads this same shared script (one fix applies everywhere)', () => {
  const consumers = [
    'views/kiosk-class-checkin-scan.ejs',
    'views/kiosk-find-parent.ejs',
    'views/admin-events-checkin-scan.ejs',
    'views/admin-orientation-checkin-scan.ejs',
  ];
  consumers.forEach((view) => {
    const html = fs.readFileSync(path.join(__dirname, '..', view), 'utf8');
    assert.match(html, /src="\/js\/kiosk-camera-scanner\.js"/, `expected ${view} to load the shared camera scanner script`);
  });
});
