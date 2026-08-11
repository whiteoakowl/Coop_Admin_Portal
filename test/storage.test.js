// Real coverage for utils/storage.js's own logic (key generation, which
// bucket/args it calls, error handling, URL building) using a fake
// Supabase client shaped like @supabase/supabase-js's real one - this
// suite can't exercise an actual Storage upload (no network access to
// supabase.co from this environment, and there's no in-process fake
// Storage engine the way PGlite gives Postgres) - see MIGRATION.md's own
// note on that. What it does prove: uploadFile/deleteFile call the
// client with exactly the arguments a real @supabase/supabase-js client
// expects, and handle its documented { error } result shape correctly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadFile, deleteFile, publicUrl, generateKey, createStorageClient } = require('../utils/storage');

// Mirrors @supabase/supabase-js's client.storage.from(bucket).upload/remove
// shape closely enough to prove utils/storage.js calls it correctly,
// without needing the real package's network behavior.
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

test('generateKey', () => {
  const key = generateKey('My Photo.JPG');
  assert.match(key, /^\d+-\d+\.jpg$/, 'timestamp-random.ext, lowercased extension, same shape as the old local-disk filenames');
});

test('uploadFile', async (t) => {
  await t.test('uploads the buffer to the right bucket/key and returns the generated key', async () => {
    const client = fakeClient();
    const buffer = Buffer.from('fake image bytes');
    const key = await uploadFile(client, 'member-photos', buffer, 'kid.png', 'image/png');

    assert.equal(client.calls.uploads.length, 1);
    assert.equal(client.calls.uploads[0].bucket, 'member-photos');
    assert.equal(client.calls.uploads[0].key, key);
    assert.equal(client.calls.uploads[0].buffer, buffer);
    assert.equal(client.calls.uploads[0].options.contentType, 'image/png');
    assert.equal(client.calls.uploads[0].options.upsert, false, 'a freshly generated key should never collide, so upsert has nothing to overwrite');
    assert.match(key, /\.png$/);
  });

  await t.test('throws with a clear message when Supabase reports an error, instead of silently returning a broken key', async () => {
    const client = fakeClient({ uploadError: { message: 'bucket not found' } });
    await assert.rejects(
      uploadFile(client, 'member-photos', Buffer.from('x'), 'kid.png', 'image/png'),
      /Supabase Storage upload failed \(member-photos\/.*\): bucket not found/
    );
  });
});

test('deleteFile', async (t) => {
  await t.test('removes the given key from the given bucket', async () => {
    const client = fakeClient();
    await deleteFile(client, 'member-photos', 'some-key.png');
    assert.deepEqual(client.calls.removes, [{ bucket: 'member-photos', keys: ['some-key.png'] }]);
  });

  await t.test('is a no-op for a falsy key (member with no photo set), not an error', async () => {
    const client = fakeClient();
    await deleteFile(client, 'member-photos', null);
    assert.equal(client.calls.removes.length, 0);
  });
});

test('publicUrl', () => {
  const originalUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  try {
    assert.equal(
      publicUrl('member-photos', 'abc-123.png'),
      'https://example.supabase.co/storage/v1/object/public/member-photos/abc-123.png'
    );
    assert.equal(publicUrl('member-photos', null), null, 'no key (nothing uploaded) should give no URL, not a broken one');
  } finally {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
  }
});

test('createStorageClient returns null (not a throw) when SUPABASE_URL/SERVICE_ROLE_KEY aren\'t configured', () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.equal(createStorageClient(), null);
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});
