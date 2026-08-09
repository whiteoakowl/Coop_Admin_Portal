// Real unit coverage for the error-log file (see utils/logger.js's own
// comment for why this exists - console.error alone is useless once the
// terminal window this app runs in gets closed or scrolled past).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testLogPath = path.join(os.tmpdir(), `logger-test-${process.pid}.log`);
process.env.ERROR_LOG_PATH = testLogPath;
const { logError, LOG_PATH } = require('../utils/logger');

test('logger', async (t) => {
  t.after(() => {
    fs.rmSync(testLogPath, { force: true });
  });

  await t.test('picks up the ERROR_LOG_PATH override', () => {
    assert.equal(LOG_PATH, testLogPath);
  });

  await t.test('writes a timestamped entry with the error stack', () => {
    fs.rmSync(testLogPath, { force: true });
    logError('GET /some/route', new Error('boom'));
    const content = fs.readFileSync(testLogPath, 'utf8');
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] GET \/some\/route/);
    assert.match(content, /Error: boom/);
  });

  await t.test('handles a non-Error rejection reason without throwing', () => {
    fs.rmSync(testLogPath, { force: true });
    assert.doesNotThrow(() => logError('unhandledRejection', 'a plain string reason'));
    const content = fs.readFileSync(testLogPath, 'utf8');
    assert.match(content, /a plain string reason/);
  });

  await t.test('appends rather than overwriting on repeated calls', () => {
    fs.rmSync(testLogPath, { force: true });
    logError('first', new Error('one'));
    logError('second', new Error('two'));
    const content = fs.readFileSync(testLogPath, 'utf8');
    assert.match(content, /one/);
    assert.match(content, /two/);
  });

  await t.test('trims the file once it exceeds the size cap, keeping it well under the cap', () => {
    fs.rmSync(testLogPath, { force: true });
    // Each call appends a few hundred bytes; enough calls crosses the
    // real 2MB cap so this exercises the actual trimming path, not a
    // shrunk test-only threshold.
    for (let i = 0; i < 6000; i++) {
      logError(`entry ${i}`, new Error(`padding padding padding padding padding #${i}`));
    }
    const stat = fs.statSync(testLogPath);
    assert.ok(stat.size < 2 * 1024 * 1024, `expected the log to have been trimmed, got ${stat.size} bytes`);
    assert.ok(stat.size > 0, 'trimming should not have deleted everything');
    const content = fs.readFileSync(testLogPath, 'utf8');
    // The most recent entry must have survived the trim.
    assert.match(content, /entry 5999/);
    // The file should start cleanly at an entry boundary, not mid-stack-trace.
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T/);
  });
});
