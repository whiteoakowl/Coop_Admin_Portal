// Real coverage for utils/uploadBackend.js's dual-backend logic (Supabase
// Storage when a client is passed, local disk when it's null) - exercises
// both modes directly against a throwaway temp directory and a fake
// Supabase client shaped like test/storage.test.js's own, proving
// uploadBackend.js and storage.js compose correctly end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveUpload, removeUpload, urlForUpload } = require('../utils/uploadBackend');

function fakeClient({ uploadError = null, removeError = null } = {}) {
  const calls = { uploads: [], removes: [] };
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          async upload(key, buffer, options) {
            calls.uploads.push({ bucket, key, buffer, options });
            return { error: uploadError };
          },
          async remove(keys) {
            calls.removes.push({ bucket, keys });
            return { error: removeError };
          },
        };
      },
    },
  };
}

test('saveUpload', async (t) => {
  await t.test('writes to local disk and returns a bare key when client is null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploadbackend-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const key = await saveUpload({
      client: null,
      bucket: 'member-photos',
      localDir: dir,
      buffer: Buffer.from('img bytes'),
      originalName: 'kid.png',
      contentType: 'image/png',
    });
    assert.match(key, /^\d+-\d+\.png$/);
    assert.equal(fs.readFileSync(path.join(dir, key)).toString(), 'img bytes');
  });

  await t.test('uploads to Supabase Storage and returns its key when a client is given', async () => {
    const client = fakeClient();
    const key = await saveUpload({
      client,
      bucket: 'member-photos',
      localDir: '/should-not-be-used',
      buffer: Buffer.from('img bytes'),
      originalName: 'kid.png',
      contentType: 'image/png',
    });
    assert.equal(client.calls.uploads.length, 1);
    assert.equal(client.calls.uploads[0].bucket, 'member-photos');
    assert.equal(client.calls.uploads[0].key, key);
  });
});

test('removeUpload', async (t) => {
  await t.test('deletes from local disk when client is null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploadbackend-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'abc.png'), 'x');
    await removeUpload({ client: null, bucket: 'member-photos', localDir: dir, key: 'abc.png' });
    assert.equal(fs.existsSync(path.join(dir, 'abc.png')), false);
  });

  await t.test('deletes from local disk using just the basename for a pre-migration full-path key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploadbackend-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'abc.png'), 'x');
    await removeUpload({ client: null, bucket: 'member-photos', localDir: dir, key: '/uploads/members/abc.png' });
    assert.equal(fs.existsSync(path.join(dir, 'abc.png')), false);
  });

  await t.test('is a no-op for a falsy key regardless of backend', async () => {
    const client = fakeClient();
    await removeUpload({ client, bucket: 'member-photos', localDir: '/tmp', key: null });
    assert.equal(client.calls.removes.length, 0);
  });

  await t.test('removes from Supabase Storage when a client is given', async () => {
    const client = fakeClient();
    await removeUpload({ client, bucket: 'member-photos', localDir: '/tmp', key: 'abc.png' });
    assert.deepEqual(client.calls.removes, [{ bucket: 'member-photos', keys: ['abc.png'] }]);
  });
});

test('urlForUpload', async (t) => {
  await t.test('returns an already-full local path unchanged (pre-migration data)', () => {
    const url = urlForUpload({ client: null, bucket: 'member-photos', webDir: '/uploads/members', key: '/uploads/members/old-style.jpg' });
    assert.equal(url, '/uploads/members/old-style.jpg');
  });

  await t.test('builds a local webDir path from a bare key when client is null', () => {
    const url = urlForUpload({ client: null, bucket: 'member-photos', webDir: '/uploads/members', key: 'abc-123.jpg' });
    assert.equal(url, '/uploads/members/abc-123.jpg');
  });

  await t.test('builds a Supabase public URL from a bare key when a client is given', () => {
    const savedUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    try {
      const url = urlForUpload({ client: fakeClient(), bucket: 'member-photos', webDir: '/uploads/members', key: 'abc-123.jpg' });
      assert.equal(url, 'https://example.supabase.co/storage/v1/object/public/member-photos/abc-123.jpg');
    } finally {
      if (savedUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = savedUrl;
    }
  });

  await t.test('returns null for a falsy key', () => {
    assert.equal(urlForUpload({ client: null, bucket: 'member-photos', webDir: '/uploads/members', key: null }), null);
  });
});
