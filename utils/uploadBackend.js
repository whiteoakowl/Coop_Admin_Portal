// Shared "save an admin-uploaded file either to Supabase Storage or local
// disk" helper - routes/admin-members.js (member/child photos),
// routes/membership.js (membership request child photos),
// routes/admin-name-tag.js and routes/admin-schedule.js (design images)
// all follow the exact same conditional shape, so it's factored out here
// once instead of once per route. See MIGRATION.md for why both backends
// still coexist.
//
// Every function here takes `client` as an explicit argument (the result
// of utils/storage.js's own createStorageClient() - null when Supabase
// isn't configured) rather than calling createStorageClient() internally
// - same reasoning as utils/storage.js's own header comment: it's what
// makes this testable with a fake client instead of a real network call,
// and it means each call site decides once (typically at the top of a
// request handler) which backend is active, instead of every helper call
// re-deriving it.
const fs = require('fs');
const path = require('path');
const { uploadFile, deleteFile, publicUrl, generateKey } = require('./storage');

// Saves `buffer` under `bucket` in Supabase Storage when `client` is
// non-null, otherwise writes it under `localDir` on disk - either way
// returns the bare key that should be stored in the DB column (both
// backends use generateKey()'s identical timestamp-random.ext shape, so a
// key alone never reveals which backend actually holds it).
async function saveUpload({ client, bucket, localDir, buffer, originalName, contentType }) {
  if (client) return uploadFile(client, bucket, buffer, originalName, contentType);
  const key = generateKey(originalName);
  fs.writeFileSync(path.join(localDir, key), buffer);
  return key;
}

// Removes a previously saved key from whichever backend `client` selects.
// Silently no-ops for a falsy key (nothing was ever uploaded), matching
// every existing delete-photo call site's behavior.
async function removeUpload({ client, bucket, localDir, key }) {
  if (!key) return;
  if (client) return deleteFile(client, bucket, key);
  // path.basename() so a pre-migration full-path key (e.g.
  // "/uploads/members/172...jpg", see urlForUpload's own comment on that
  // convention) still resolves to the right file under localDir instead
  // of a bogus nested path that never exists.
  const filePath = path.join(localDir, path.basename(key));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// Computes the URL a view template (or a JSON API response consumed by
// client-side JS) should use for a stored key. `key` may also already be
// a full local web path (e.g. "/uploads/members/172...jpg") - the
// convention every one of these columns used *before* this Storage wiring
// landed - and is returned as-is in that case, so rows written before
// this change keep rendering correctly instead of getting a second
// "/uploads/..." prefix stapled onto an already-complete path.
function urlForUpload({ client, bucket, webDir, key }) {
  if (!key) return null;
  if (key.startsWith('/')) return key;
  if (client) return publicUrl(bucket, key);
  return `${webDir}/${key}`;
}

module.exports = { saveUpload, removeUpload, urlForUpload };
