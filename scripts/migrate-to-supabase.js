#!/usr/bin/env node
// One-time production cutover script: copies every row out of the local
// SQLite database (data/attendance.db) and every file out of
// public/uploads/* into the already-provisioned Supabase Postgres database
// and Storage buckets. See MIGRATION.md's "Production data export/import"
// section for the full runbook (when to run this, what has to land first,
// how to verify the result) - this file is deliberately just the mechanics.
//
// This is NOT part of the app's normal boot path (db/bootstrapPg.js is
// that - fresh-database seeding for a brand new install). This script runs
// exactly once, by hand, at the moment of cutover, against a real
// production SQLite file and a real (empty, freshly-migrated) Supabase
// project - never automatically, never in CI, never against test data.
//
// Usage:
//   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/migrate-to-supabase.js [--dry-run] [--skip-files] [--skip-rows]
//
//   --dry-run     Don't write anything anywhere. Reads the SQLite file and
//                 the uploads directories, prints exactly what would be
//                 migrated (row counts per table, file counts per bucket),
//                 then exits. Doesn't require DATABASE_URL/SUPABASE_* to be
//                 set at all - useful for sanity-checking a production
//                 export before ever touching the real Supabase project.
//   --skip-files  Row data only, no Storage uploads (e.g. re-running after
//                 fixing a row-migration problem when the files already
//                 made it over on an earlier pass).
//   --skip-rows   Storage uploads only, no Postgres writes.
//
// Safe to re-run: file uploads use upsert:true (re-uploading the same key
// just overwrites it, byte-for-byte identical, so this is a no-op on a
// second pass), and every table this touches is copied into a table that
// should be empty (see the pre-flight check below) - this is a one-shot
// bulk load, not an incremental sync, and it refuses to run against a
// Postgres database that already has rows in it.
'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { publicUrl } = require('../utils/storage');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_FILES = args.includes('--skip-files') || DRY_RUN;
const SKIP_ROWS = args.includes('--skip-rows') || DRY_RUN;

const SQLITE_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'attendance.db');
const UPLOADS_ROOT = path.join(__dirname, '..', 'public', 'uploads');

// --- Table migration order -------------------------------------------
//
// Every table in db/schema.sql except `sessions` (express-session rows -
// ephemeral login state, not data anyone needs preserved; every admin just
// logs back in once after cutover) in an order that satisfies every
// REFERENCES/foreign key in the schema - a table only appears after every
// table it references. Verified by hand against every `REFERENCES` clause
// in db/schema.sql; kept as an explicit list (not computed by a
// topological sort at runtime) so the order is something a human can read
// and audit, not something to trust blindly.
const TABLES_IN_ORDER = [
  'families',
  'categories',
  'admins',
  'rosters',
  'members',
  'roster_dates',
  'roster_members',
  'attendance',
  'checkouts',
  'volunteer_lists',
  'volunteer_sections',
  'volunteer_dates',
  'volunteer_members',
  'volunteer_assignments',
  'setup_teams',
  'setup_team_members',
  'task_list_sections',
  'task_list_items',
  'name_tag_requests',
  'name_tag_templates',
  'misc_badge_templates',
  'misc_badges',
  'member_schedules',
  'schedule_card_templates',
  'class_schedule_hours',
  'classes',
  'class_enrollments',
  'class_staff',
  'app_settings',
  'leadership_contacts',
  'contact_admin_messages',
  'membership_requests',
  'membership_request_children',
  'documents',
  'permanent_jobs',
  'permanent_job_floaters',
  'substitute_assignments',
  'library_items',
  'library_item_types',
  'library_checkouts',
  'roster_archives',
];

// --- File uploads -> Storage buckets -----------------------------------
//
// One bucket per local uploads/ subdirectory, mirroring the directory
// structure 1:1 - see MIGRATION.md's bucket list for the reasoning behind
// each name and its public/private setting. `documents` is the one
// PRIVATE bucket: routes/admin-documents.js gates every document behind
// requireFullAdmin, and a public bucket would make that gate meaningless
// (anyone with the URL could read it, no login required) - IMPORTANT: as
// of this script, routes/admin-documents.js still serves documents from
// local disk (res.sendFile), not Storage. Before this bucket is actually
// used in production, that route needs a signed-URL (or server-side
// proxy-download) helper added to utils/storage.js - there isn't one yet.
// Create this bucket as private in the Supabase dashboard either way, so
// a future oversight can't accidentally make it public by default.
const UPLOAD_DIRS = [
  { dir: 'members', bucket: 'member-photos', public: true },
  { dir: 'membership-children', bucket: 'membership-child-photos', public: true },
  { dir: 'name-tags', bucket: 'name-tag-images', public: true },
  { dir: 'schedule-cards', bucket: 'schedule-card-images', public: true },
  { dir: 'documents', bucket: 'documents', public: false },
];

// members.photo_path / membership_request_children.photo_path /
// documents.file_path today store a full local URL path
// (`/uploads/members/172...-482...png`, set by each route's
// multer.diskStorage() filename callback). utils/storage.js's own
// convention (see its header comment) is that these columns should hold
// just the Storage *key* going forward, with publicUrl()/a future
// signed-URL helper building the actual URL at render time - so this is
// where that local-path -> bare-key rewrite happens, once, for every
// existing row.
//
// This only actually renders correctly once the upload routes themselves
// (routes/admin-members.js, routes/membership.js, routes/admin-documents.js)
// and their view templates are switched from multer.diskStorage()/
// res.sendFile to utils/storage.js - that swap is still pending (see
// netlify/functions/app.js's header comment) and MUST land in the same
// deploy as running this script, or photos/documents will 404 until it
// does.
const PATH_COLUMN_REWRITES = [
  { table: 'members', column: 'photo_path', dir: 'members' },
  { table: 'membership_request_children', column: 'photo_path', dir: 'membership-children' },
  { table: 'documents', column: 'file_path', dir: 'documents' },
];

// name_tag_templates/misc_badge_templates/schedule_card_templates.layout_json
// is a JSON array of positioned elements (see db/schema.sql's comment on
// name_tag_templates); a background/decoration element looks like
// { type: 'image', src: '/uploads/name-tags/172...-482...png', ... }.
// Unlike photo_path/file_path above, this src is consumed directly as a
// literal URL by client-side rendering code (the admin design editor's
// live preview and public/js/name-tag-render-core.js, used for both
// on-screen preview and print) - there's no server-side "look up the key,
// call publicUrl()" step for these at render time the way there is for a
// normal DB column, so this is the one place a *full* public Storage URL
// gets stored directly rather than a bare key. That's a deliberate,
// narrow exception to the bare-key convention above, not an inconsistency.
const LAYOUT_JSON_TABLES = ['name_tag_templates', 'misc_badge_templates', 'schedule_card_templates'];

function log(...msg) {
  console.log(...msg);
}

// --- File migration ------------------------------------------------------

// Tiny extension -> content-type map covering everything these upload
// routes actually accept (see each route's multer fileFilter) - not a
// general-purpose mime library, just enough for correct Storage
// Content-Type headers on the file types this app ever stores.
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
};

function contentTypeFor(filename) {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

// Uploads every file under public/uploads/<dir> to its mapped bucket,
// reusing the existing filename as the Storage key (not
// utils/storage.js's generateKey() - that's for brand-new uploads going
// forward; reusing today's filename here means this step is trivially
// idempotent to re-run and needs no separate old-name -> new-key mapping
// table). Returns a Map from `${dir}/${filename}` to
// { bucket, key, publicUrl } for the row-migration step to consult.
async function migrateFiles(storageClient) {
  const fileMap = new Map();
  for (const { dir, bucket, public: isPublic } of UPLOAD_DIRS) {
    const localDir = path.join(UPLOADS_ROOT, dir);
    if (!fs.existsSync(localDir)) {
      log(`  ${dir}/: no local directory, skipping (nothing was ever uploaded here)`);
      continue;
    }
    const files = fs.readdirSync(localDir).filter((f) => fs.statSync(path.join(localDir, f)).isFile());
    log(`  ${dir}/ -> bucket "${bucket}" (${isPublic ? 'public' : 'private'}): ${files.length} file(s)`);
    for (const filename of files) {
      const key = filename;
      fileMap.set(`${dir}/${filename}`, {
        bucket,
        key,
        publicUrl: isPublic ? publicUrl(bucket, key) : null,
      });
      if (SKIP_FILES) continue;
      const buffer = fs.readFileSync(path.join(localDir, filename));
      const { error } = await storageClient.storage.from(bucket).upload(key, buffer, {
        contentType: contentTypeFor(filename),
        upsert: true,
      });
      if (error) {
        throw new Error(`Upload failed for ${dir}/${filename} -> ${bucket}/${key}: ${error.message}`);
      }
    }
  }
  return fileMap;
}

// Rewrites a `/uploads/<dir>/<filename>` path found in a plain DB column
// (photo_path/file_path) to the bare Storage key, using the map
// migrateFiles() built. Leaves the value untouched (including null) if it
// doesn't match that pattern or wasn't found in the map - a row with no
// photo, or one whose file is already missing from disk, shouldn't block
// the whole migration.
function rewritePathColumn(value, dir, fileMap) {
  if (!value) return value;
  const prefix = `/uploads/${dir}/`;
  if (!value.startsWith(prefix)) return value;
  const filename = value.slice(prefix.length);
  const entry = fileMap.get(`${dir}/${filename}`);
  return entry ? entry.key : value;
}

// Rewrites every image element's src inside a layout_json blob from a
// local `/uploads/<name-tags|schedule-cards>/<filename>` path to the full
// public Storage URL - see LAYOUT_JSON_TABLES's comment above for why a
// full URL (not a bare key) is correct here specifically.
function rewriteLayoutJson(layoutJsonText, fileMap) {
  let elements;
  try {
    elements = JSON.parse(layoutJsonText);
  } catch {
    return layoutJsonText; // not valid JSON (shouldn't happen) - leave as-is rather than crash the migration
  }
  if (!Array.isArray(elements)) return layoutJsonText;
  const rewritten = elements.map((el) => {
    if (!el || el.type !== 'image' || typeof el.src !== 'string') return el;
    const match = el.src.match(/^\/uploads\/(name-tags|schedule-cards)\/(.+)$/);
    if (!match) return el;
    const [, dir, filename] = match;
    const entry = fileMap.get(`${dir}/${filename}`);
    if (!entry || !entry.publicUrl) return el;
    return { ...el, src: entry.publicUrl };
  });
  return JSON.stringify(rewritten);
}

// --- Row migration ---------------------------------------------------------

async function isIdentityColumn(pg, table) {
  const { rows } = await pg.query(
    `select is_identity from information_schema.columns where table_name = $1 and column_name = 'id'`,
    [table]
  );
  return rows.length > 0 && rows[0].is_identity === 'YES';
}

async function migrateTable(sqlite, pg, table, fileMap) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) {
    log(`  ${table}: 0 rows`);
    return;
  }
  const columns = Object.keys(rows[0]);
  const pathRewrite = PATH_COLUMN_REWRITES.find((r) => r.table === table);
  const isLayoutJsonTable = LAYOUT_JSON_TABLES.includes(table);
  const identity = await isIdentityColumn(pg, table);
  const overriding = identity ? 'OVERRIDING SYSTEM VALUE' : '';
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${table} (${columns.join(', ')}) ${overriding} VALUES (${placeholders})`;

  if (!SKIP_ROWS) {
    for (const row of rows) {
      const values = columns.map((col) => {
        let v = row[col];
        if (pathRewrite && col === pathRewrite.column) v = rewritePathColumn(v, pathRewrite.dir, fileMap);
        if (isLayoutJsonTable && col === 'layout_json' && typeof v === 'string') v = rewriteLayoutJson(v, fileMap);
        return v;
      });
      await pg.query(insertSql, values);
    }
    if (identity) {
      // Bulk-loaded explicit ids leave the identity sequence at its
      // starting value (1) - the next real INSERT through the app would
      // collide with an id that already exists. Reset it to one past the
      // highest id actually inserted; the `is not null` third argument
      // keeps this a no-op-safe call even if the table somehow ended up
      // empty.
      await pg.query(
        `select setval(pg_get_serial_sequence('${table}', 'id'), coalesce((select max(id) from ${table}), 1), (select max(id) from ${table}) is not null)`
      );
    }
  }
  log(`  ${table}: ${rows.length} row(s)${identity ? ' (sequence reset)' : ''}`);
}

// --- Pre-flight --------------------------------------------------------

// Refuses to run against a Postgres database that isn't empty - this
// script is a one-shot bulk load with explicit ids (OVERRIDING SYSTEM
// VALUE), not an upsert/merge; running it twice against a database that
// already has the first run's rows would either duplicate everything (for
// the composite-PK tables) or fail on a unique-constraint violation
// (everywhere else) partway through. If a second pass is genuinely needed
// (fixing a bad first attempt), truncate the Supabase database back to
// empty first - do NOT bypass this check.
async function assertTargetIsEmpty(pg) {
  const { rows } = await pg.query('SELECT COUNT(*) FROM families');
  if (Number(rows[0].count) > 0) {
    throw new Error(
      'Target Postgres database already has rows in it (families is not empty). ' +
        'Refusing to run - this script is a one-shot bulk load, not a merge. ' +
        'If you need to re-run it, truncate the Supabase database back to empty first.'
    );
  }
}

// --- Main ----------------------------------------------------------------

async function main() {
  log(`Reading SQLite database: ${SQLITE_PATH}`);
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`No SQLite database at ${SQLITE_PATH} - set DB_PATH to point at the production file.`);
  }
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });

  let pg = null;
  let storageClient = null;

  if (!SKIP_ROWS) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (unset --skip-rows to skip row migration instead).');
    pg = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  if (!SKIP_FILES) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (unset --skip-files to skip file migration instead).');
    }
    storageClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }

  try {
    if (DRY_RUN) log('--- DRY RUN: no writes will be made ---\n');

    log('Step 1/3: files -> Storage buckets');
    const fileMap = await migrateFiles(storageClient);

    let client = pg;
    if (pg && !SKIP_ROWS) {
      client = await pg.connect();
      if (!DRY_RUN) await assertTargetIsEmpty(client);
      await client.query('BEGIN');
    }
    try {
      log('\nStep 2/3: rows -> Postgres (in foreign-key-safe order)');
      for (const table of TABLES_IN_ORDER) {
        await migrateTable(sqlite, client || { query: async () => ({ rows: [] }) }, table, fileMap);
      }
      if (client && !SKIP_ROWS) {
        if (DRY_RUN) {
          await client.query('ROLLBACK');
        } else {
          await client.query('COMMIT');
        }
      }
    } catch (err) {
      if (client && !SKIP_ROWS) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (client && client !== pg) client.release();
    }

    log('\nStep 3/3: done.');
    if (DRY_RUN) log('(dry run - nothing was actually written)');
  } finally {
    sqlite.close();
    if (pg) await pg.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
