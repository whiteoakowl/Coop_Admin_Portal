// Supabase Storage wrapper - the eventual replacement for every route
// file's local-disk multer.diskStorage() (member/child photos, name tag
// and schedule card design images, uploaded documents). Local disk isn't
// persistent on Netlify Functions - every request can land on a fresh
// container with an empty filesystem - so uploaded files have to live
// somewhere external too, same reasoning as the database itself moving to
// Supabase Postgres (see MIGRATION.md).
//
// Storage doesn't have a "raw connection" equivalent the way Postgres
// does (db/postgres.js talks straight to Postgres over the wire, no
// Supabase-specific client needed) - it's an HTTP API, so this is the one
// place in the whole migration that genuinely uses the
// @supabase/supabase-js client library, not a workaround.
//
// The client is passed in, not constructed internally on every call -
// this is what makes createUploader() below testable without a real
// network call: tests inject a small fake object shaped like
// @supabase/supabase-js's client instead of a real one. See
// test/storage.test.js.
const { createClient } = require('@supabase/supabase-js');

// One real client per process, built from env vars - never the anon key,
// since these uploads (member photos, admin-managed documents, design
// images) are written by server-side admin routes, not directly by a
// browser; the service_role key is what actually has Storage write
// access. Returns null (not a throw) when unconfigured, so routes/tests
// that don't need Storage yet don't have to set these vars just to boot.
function createStorageClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Same key-generation scheme every local-disk uploader already used
// (Date.now() + a random int + the original extension) - kept identical
// so the *shape* of what gets stored in a photo_path/file_path column
// doesn't change, just where that key actually lives.
function generateKey(originalName) {
  const ext = require('path').extname(originalName || '').toLowerCase();
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

// Uploads a buffer (req.file.buffer, from multer's memoryStorage - no
// local disk write happens anywhere in this path) to `bucket` under a
// freshly generated key, returning that key. Callers store the key itself
// in the DB (same as today's photo_path/file_path columns already store
// just a local filename) and build the servable URL later via
// publicUrl() - never store a full URL, since a bucket could be renamed
// or made private later without every stored row needing to change.
async function uploadFile(client, bucket, buffer, originalName, contentType) {
  const key = generateKey(originalName);
  const { error } = await client.storage.from(bucket).upload(key, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Supabase Storage upload failed (${bucket}/${key}): ${error.message}`);
  return key;
}

function deleteFile(client, bucket, key) {
  if (!key) return Promise.resolve();
  return client.storage.from(bucket).remove([key]);
}

// Public buckets (see MIGRATION.md's bucket list) serve a stable, directly
// linkable URL with no signing/expiry - the same "just works in an <img
// src>" behavior public/uploads/* already has today. Bucket + key alone
// determine the URL; no async call needed to compute it (Supabase's own
// getPublicUrl() is a pure string-builder, not a network call, but this
// wrapper builds it directly so publicUrl() works even when
// createStorageClient() returned null, e.g. in a view-rendering context
// that only needs the URL shape, not write access).
function publicUrl(bucket, key) {
  if (!key) return null;
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/${bucket}/${key}`;
}

module.exports = { createStorageClient, uploadFile, deleteFile, publicUrl, generateKey };
