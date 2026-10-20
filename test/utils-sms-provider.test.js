// Coverage for a real request: "We are going to setup text messaging
// using telnyx." utils/smsProvider.js used to be a pure stub ("no SMS
// vendor configured anywhere in this app") - this is a plain unit test
// (no db/server setup needed, same as any other utils/*.js module with
// no db import) covering the real Telnyx wiring behind the exact same
// send(phone, message)/isConfigured() contract utils/notifications.js
// already calls through.
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['TELNYX_API_KEY', 'TELNYX_MESSAGING_PROFILE_ID', 'TELNYX_FROM_NUMBER'];
let savedEnv;
let savedFetch;

test.beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedFetch = global.fetch;
  // A fresh require each time so module-level nothing can leak between
  // tests - smsProvider.js has no module-level state today, but this
  // keeps the test immune if it ever grows any.
  delete require.cache[require.resolve('../utils/smsProvider')];
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = savedFetch;
});

test('isConfigured() is false with no Telnyx env vars set, true once an API key and a from-number/profile are both set', () => {
  const smsProvider = require('../utils/smsProvider');
  assert.equal(smsProvider.isConfigured(), false);

  process.env.TELNYX_API_KEY = 'test-key';
  assert.equal(smsProvider.isConfigured(), false, 'an API key alone, with no from-number or messaging profile, is still unconfigured');

  process.env.TELNYX_FROM_NUMBER = '+15555550123';
  assert.equal(smsProvider.isConfigured(), true);
});

test('toE164() normalizes a 10-digit or 11-digit (leading 1) US number, passes through an already-"+" number, and rejects everything else', () => {
  const { toE164 } = require('../utils/smsProvider');
  assert.equal(toE164('(555) 123-4567'), '+15551234567');
  assert.equal(toE164('555-123-4567'), '+15551234567');
  assert.equal(toE164('15551234567'), '+15551234567');
  assert.equal(toE164('+15551234567'), '+15551234567');
  assert.equal(toE164('5551234'), null, 'too short to be a real number');
  assert.equal(toE164(''), null);
  assert.equal(toE164(null), null);
});

test('send(): no phone on file, or no provider configured, is skipped - never a fake "sent" - and never calls fetch at all', async () => {
  const smsProvider = require('../utils/smsProvider');
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not have been called');
  };

  const noPhone = await smsProvider.send(null, 'hello');
  assert.deepEqual(noPhone, { status: 'skipped', detail: 'No phone number on file.' });

  const notConfigured = await smsProvider.send('555-123-4567', 'hello');
  assert.equal(notConfigured.status, 'skipped');
  assert.match(notConfigured.detail, /no sms provider configured/i);

  assert.equal(fetchCalled, false);
});

test('send(): an unusable phone number is skipped once a provider IS configured, still without calling fetch', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_FROM_NUMBER = '+15555550123';
  const smsProvider = require('../utils/smsProvider');
  global.fetch = async () => {
    throw new Error('fetch should not have been called for an unusable number');
  };

  const result = await smsProvider.send('123', 'hello');
  assert.equal(result.status, 'skipped');
  assert.match(result.detail, /isn't a usable phone number/);
});

test('send(): a successful Telnyx response reports "sent", posting to the Messages API with the from-number and E.164 "to"', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_FROM_NUMBER = '+15555550123';
  const smsProvider = require('../utils/smsProvider');

  let capturedUrl, capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => ({ data: { id: 'msg_123' } }) };
  };

  const result = await smsProvider.send('555-123-4567', 'Hello from the co-op');
  assert.deepEqual(result, { status: 'sent', detail: null, messageId: 'msg_123' });
  assert.equal(capturedUrl, 'https://api.telnyx.com/v2/messages');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.from, '+15555550123');
  assert.equal(body.to, '+15551234567');
  assert.equal(body.text, 'Hello from the co-op');
});

test('send(): a configured Messaging Profile is used instead of a from-number when both happen to be set', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-abc';
  process.env.TELNYX_FROM_NUMBER = '+15555550123';
  const smsProvider = require('../utils/smsProvider');

  let capturedBody;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await smsProvider.send('5551234567', 'hi');
  assert.equal(capturedBody.messaging_profile_id, 'profile-abc');
  assert.equal(capturedBody.from, undefined);
});

test('send(): a Telnyx error response reports "failed" with that error\'s own detail, never a fake "sent"', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_FROM_NUMBER = '+15555550123';
  const smsProvider = require('../utils/smsProvider');

  global.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ errors: [{ code: '10015', title: 'Invalid "to" field', detail: 'The "to" field contains an invalid number.' }] }),
  });

  const result = await smsProvider.send('555-123-4567', 'hello');
  assert.equal(result.status, 'failed');
  assert.equal(result.detail, 'The "to" field contains an invalid number.');
});

test('send(): a network/fetch-level error also reports "failed", with the exception\'s own message', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_FROM_NUMBER = '+15555550123';
  const smsProvider = require('../utils/smsProvider');

  global.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.telnyx.com');
  };

  const result = await smsProvider.send('555-123-4567', 'hello');
  assert.equal(result.status, 'failed');
  assert.equal(result.detail, 'getaddrinfo ENOTFOUND api.telnyx.com');
});

test('getStatus(): with no API key configured, returns an error without calling fetch', async () => {
  const smsProvider = require('../utils/smsProvider');
  global.fetch = async () => {
    throw new Error('fetch should not have been called');
  };

  const result = await smsProvider.getStatus('msg_123');
  assert.match(result.error, /no sms provider configured/i);
});

test('getStatus(): a successful lookup reports the per-recipient delivery status, GETting the message by id', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  const smsProvider = require('../utils/smsProvider');

  let capturedUrl, capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          to: [{ phone_number: '+15551234567', status: 'delivered' }],
          from: { phone_number: '+15555550123' },
          sent_at: '2026-01-01T00:00:00Z',
          completed_at: '2026-01-01T00:00:05Z',
          errors: [],
        },
      }),
    };
  };

  const result = await smsProvider.getStatus('msg_123');
  assert.equal(capturedUrl, 'https://api.telnyx.com/v2/messages/msg_123');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(result, {
    to: '+15551234567',
    status: 'delivered',
    from: '+15555550123',
    sentAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:05Z',
    errors: [],
  });
});

test('getStatus(): a Telnyx error response (e.g. a message older than 10 days, or an unknown id) returns that error, never a fake status', async () => {
  process.env.TELNYX_API_KEY = 'test-key';
  const smsProvider = require('../utils/smsProvider');

  global.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ errors: [{ code: '10007', title: 'Record not found', detail: 'The requested resource could not be found.' }] }),
  });

  const result = await smsProvider.getStatus('does-not-exist');
  assert.equal(result.error, 'The requested resource could not be found.');
});
