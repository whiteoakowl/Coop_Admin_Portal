// Coverage for a real request: "Class check in and out. It should beep
// each time a person is scanned and show a checked in or checked out
// notification before allowing more continuous scan." Answered question:
// auto-dismiss the confirmation after ~1.5-2s rather than require a tap.
// public/js/kiosk-common.js's own playKioskBeep() and public/js/kiosk-
// class-checkin-scan.js's own submitValue()/scanLocked are plain client-
// side JS with no server route behind them to exercise through supertest,
// so this checks the actual shipped file content instead - the same
// pattern test/routes-parent-portal-classroom-dashboard-withdraw.test.js
// already uses for its own withdraw-confirmation JS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('kiosk-common.js defines a shared playKioskBeep helper using the Web Audio API', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'kiosk-common.js'), 'utf8');
  assert.match(js, /function playKioskBeep\(success\)/);
  assert.match(js, /AudioContext/);
  assert.match(js, /exported keepInputFocused, initKioskMethodChooser, registerKioskPageCleanup, playKioskBeep/);
});

test('kiosk-class-checkin-scan.js beeps on both success and failure, and locks out further scans until the confirmation auto-dismisses', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'kiosk-class-checkin-scan.js'), 'utf8');
  assert.match(js, /global keepInputFocused, initIdKeypad, initKioskMethodChooser, createKioskCameraScanner, playKioskBeep/);
  assert.match(js, /let scanLocked = false;/);
  // Guards every entry point (ignores a new scan while the previous
  // result is still showing), not just the camera's own frame-decode
  // guard - submitValue's own early return, plus both form submit
  // handlers (hardware/manual barcode entry and typed-name entry).
  assert.match(js, /if \(!value \|\| scanLocked\) return;/);
  assert.match(js, /form\.addEventListener\('submit', \(e\) => \{\s*e\.preventDefault\(\);\s*if \(scanLocked\) return;/);
  assert.match(js, /nameForm\.addEventListener\('submit', \(e\) => \{\s*e\.preventDefault\(\);\s*if \(scanLocked\) return;/);
  // Beeps on a successful check-in/out AND on an error (wrong/unknown
  // barcode, connection error) - "beep each time a person is scanned",
  // not just on success.
  const successBeepCount = (js.match(/playKioskBeep\(true\)/g) || []).length;
  const failureBeepCount = (js.match(/playKioskBeep\(false\)/g) || []).length;
  assert.equal(successBeepCount, 1, 'exactly one success beep call (the ok branch)');
  assert.equal(failureBeepCount, 2, 'a failure beep call for both the not-ok branch and the connection-error catch');
  // Auto-dismisses and unlocks after ~1.5-2s (the confirmed answer),
  // not on a tap.
  assert.match(js, /lockMs = 2000/);
  assert.match(js, /scanLocked = false;/);
});
