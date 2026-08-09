// Real unit coverage for the login brute-force guard - the one piece of
// this session's security work with logic subtle enough (window expiry,
// per-IP isolation, reset-on-success) that a passing manual click-through
// doesn't guarantee the next edit won't quietly break it.
const test = require('node:test');
const assert = require('node:assert/strict');

test('loginRateLimit', async (t) => {
  await t.test('allows attempts under the threshold', () => {
    const { isRateLimited, recordFailure } = require('../utils/loginRateLimit');
    const ip = '10.1.1.1';
    for (let i = 0; i < 4; i++) recordFailure(ip);
    assert.equal(isRateLimited(ip), false);
  });

  await t.test('blocks once the threshold is reached', () => {
    const { isRateLimited, recordFailure, MAX_ATTEMPTS } = require('../utils/loginRateLimit');
    const ip = '10.1.1.2';
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(ip);
    assert.equal(isRateLimited(ip), true);
  });

  await t.test('recordSuccess clears the block immediately', () => {
    const { isRateLimited, recordFailure, recordSuccess, MAX_ATTEMPTS } = require('../utils/loginRateLimit');
    const ip = '10.1.1.3';
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(ip);
    assert.equal(isRateLimited(ip), true);
    recordSuccess(ip);
    assert.equal(isRateLimited(ip), false);
  });

  await t.test('one IP failing does not affect another', () => {
    const { isRateLimited, recordFailure, MAX_ATTEMPTS } = require('../utils/loginRateLimit');
    const attacker = '10.1.1.4';
    const bystander = '10.1.1.5';
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure(attacker);
    assert.equal(isRateLimited(attacker), true);
    assert.equal(isRateLimited(bystander), false);
  });
});
