// Real unit coverage for the generic public-form rate limiter (see
// utils/rateLimit.js's own comment for how this differs from the
// login-specific utils/loginRateLimit.js it was generalized from -
// mainly, every attempt counts here, not just failures).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../utils/rateLimit');

test('rateLimit', async (t) => {
  await t.test('allows attempts under the threshold', () => {
    const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 5 });
    const ip = '10.2.1.1';
    for (let i = 0; i < 4; i++) limiter.recordAttempt(ip);
    assert.equal(limiter.isLimited(ip), false);
  });

  await t.test('blocks once the threshold is reached', () => {
    const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 5 });
    const ip = '10.2.1.2';
    for (let i = 0; i < 5; i++) limiter.recordAttempt(ip);
    assert.equal(limiter.isLimited(ip), true);
  });

  await t.test('one IP hitting the limit does not affect another', () => {
    const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 5 });
    const busy = '10.2.1.3';
    const quiet = '10.2.1.4';
    for (let i = 0; i < 5; i++) limiter.recordAttempt(busy);
    assert.equal(limiter.isLimited(busy), true);
    assert.equal(limiter.isLimited(quiet), false);
  });

  await t.test('a successful, valid attempt still counts toward the limit (unlike the login limiter)', () => {
    // This is the key behavioral difference from utils/loginRateLimit.js:
    // there's no "success" here to reset the counter on - a form with no
    // secret to guess can't tell a legitimate flood from an illegitimate
    // one, so every submission counts, whether or not it turned out valid.
    const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 2 });
    const ip = '10.2.1.5';
    limiter.recordAttempt(ip);
    limiter.recordAttempt(ip);
    assert.equal(limiter.isLimited(ip), true);
  });

  await t.test('the window expiring resets the count', () => {
    const limiter = createRateLimiter({ windowMs: 50, maxAttempts: 1 });
    const ip = '10.2.1.6';
    limiter.recordAttempt(ip);
    assert.equal(limiter.isLimited(ip), true);
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(limiter.isLimited(ip), false, 'the window should have expired by now');
        resolve();
      }, 75);
    });
  });
});
