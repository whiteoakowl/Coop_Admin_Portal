// Postgres/Supabase - the app's database layer. Real PostgreSQL
// (createPgDb) when DATABASE_URL is set (production/Netlify), or an
// embedded PGlite instance otherwise (local development, and every test
// file - a real Postgres engine compiled to WASM, running in-process, no
// external server or Docker required, same "just clone and run"
// experience node:sqlite used to give). See MIGRATION.md for the full
// story on this migration and why node:sqlite is gone.
//
// Two different kinds of "not ready yet" exist here, and they're
// deliberately NOT the same promise:
//
//   - `schemaReady`: PGlite has no tables until its schema is applied,
//     which is necessarily async (a real Supabase project already has
//     its schema applied via its own migrations, so this is instant
//     there). Passed into db/postgres.js's wrapQueryable so every
//     .get/.all/.run call - including ones made by seedIfMissing() below
//     - transparently waits for it. This has to be the *narrower* of the
//     two promises: seedIfMissing() itself calls db.prepare(...).get(),
//     so gating every query on "seeding has finished" would deadlock a
//     database seeding itself.
//   - `db.ready` (exported): schemaReady AND first-boot seeding
//     (db/bootstrapPg.js - default admin account, Class Check-In PIN,
//     starter templates) both done. Nothing gates on this automatically
//     - server.js awaits it before accepting real traffic, and test
//     files await it (via app.ready) before their first request/setup
//     query, the same guarantee node:sqlite's synchronous boot used to
//     give for free.
const path = require('path');
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const { createPgDb, createPgliteDb } = require('./postgres');
const {
  seedIfMissing,
  backfillNameTagLogo,
  backfillNameTagAutoFit,
  backfillMiscBadgeBarcode,
  backfillSetupCleanupTaskWraps,
  backfillSetupCleanupBadgeLayout,
  backfillSetupCleanupBadgeFields,
  backfillScheduleCardAllergy,
  backfillScheduleCardAutoFit,
  backfillParentSetupCleanupDays,
  backfillParentSetupCleanupMerge,
  backfillParentRemoveLegacyCleanupTeamElement,
  backfillNameTagStackedSizing,
  backfillTaskItemBarcodes,
} = require('./bootstrapPg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

// Every *.sql file in the migrations directory, in filename order - the
// timestamp prefix Supabase's own CLI generates (YYYYMMDDHHMMSS_name.sql)
// already sorts correctly as plain strings, so this applies them in the
// same order a real `supabase db push` would. Started as a single
// hardcoded SCHEMA_PATH pointing only at the initial migration, back when
// that was the only file that existed; a real second migration (adding a
// table after the initial cutover) would have silently never applied to
// local dev or the test suite under that scheme, so this generalized to
// "apply the whole directory" the moment a second file was added. This is
// PGlite-only (see below) - a real Supabase project applies its own
// migrations independently (see MIGRATION.md's note on running each new
// migration file in the Supabase SQL Editor, or the GitHub integration's
// auto-apply, until/unless that's automated further).
function allMigrationSql() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

let db;
let schemaReady;

if (process.env.DATABASE_URL) {
  schemaReady = Promise.resolve();
  db = createPgDb(process.env.DATABASE_URL, schemaReady);
} else {
  // Every test file sets DB_PATH to its own throwaway path (a leftover
  // convention from node:sqlite, where it selected a unique file so
  // parallel test files never shared a database) - node:test now
  // isolates each file into its own process regardless, so an in-memory
  // PGlite instance is already exactly as isolated, and much faster than
  // giving each test file its own on-disk WASM database (measured:
  // seconds per file, not the sub-second node:sqlite gave). So DB_PATH
  // being *set at all* means "give me an isolated throwaway instance" -
  // in-memory, the value itself unused - while DB_PATH being unset
  // (nothing overriding the default - a real local/LAN install run as
  // plain `node server.js`, no Supabase involved at all, see
  // MIGRATION.md's note that this is still a real, supported deployment)
  // persists to a fixed directory so data survives a restart.
  // PGlite's own constructor mkdir's this path without `recursive: true`,
  // so it throws ENOENT on a fresh checkout where `data/` itself doesn't
  // exist yet (nothing else creates it - `data/` isn't git-tracked, and
  // a real install's first run is exactly this "clone and go" case the
  // whole file's own header comment above describes). Creating it here
  // first is what makes a bare `node server.js` on a fresh clone work at
  // all, not just a repeat run where a previous boot already made it.
  let pgliteDataDir;
  if (!process.env.DB_PATH) {
    pgliteDataDir = path.join(__dirname, '..', 'data', 'pglite');
    fs.mkdirSync(pgliteDataDir, { recursive: true });
  }
  const pglite = process.env.DB_PATH ? new PGlite() : new PGlite(pgliteDataDir);
  schemaReady = (async () => {
    await pglite.exec(allMigrationSql());
  })();
  db = createPgliteDb(pglite, schemaReady);
}

db.ready = schemaReady
  .then(() => seedIfMissing(db))
  .then(() => backfillNameTagLogo(db))
  .then(() => backfillNameTagAutoFit(db))
  .then(() => backfillMiscBadgeBarcode(db))
  .then(() => backfillSetupCleanupTaskWraps(db))
  .then(() => backfillSetupCleanupBadgeLayout(db))
  .then(() => backfillScheduleCardAllergy(db))
  .then(() => backfillScheduleCardAutoFit(db))
  .then(() => backfillParentSetupCleanupDays(db))
  // Must run AFTER backfillParentSetupCleanupDays - see that backfill's
  // own comment on why this one depends on it having already run.
  .then(() => backfillParentSetupCleanupMerge(db))
  // Independent of the two backfills above - fires whether or not this
  // template has been migrated to setupCleanupDays yet, since the stale
  // element it removes predates both of them.
  .then(() => backfillParentRemoveLegacyCleanupTeamElement(db))
  .then(() => backfillNameTagStackedSizing(db))
  .then(() => backfillTaskItemBarcodes(db))
  // Must run AFTER backfillTaskItemBarcodes - it reads each task item's
  // OWN barcode column back onto its badge row, so any item that didn't
  // have one yet needs that backfill's INSERT to have run first.
  .then(() => backfillSetupCleanupBadgeFields(db))
  // Lazily required (not imported at the top of this file, unlike every
  // other backfill above) - utils/classSchedule.js itself does
  // `require('../db')`, and this whole file IS '../db' from that
  // module's perspective. Requiring it up top, before this module has
  // finished building its own exports, would hand classSchedule.js back
  // a still-incomplete module.exports (the exact real require-cycle
  // problem db/bootstrapPg.js's own header comment warns about avoiding)
  // - by the time this .then() callback actually runs, module loading is
  // long since finished and require('../db') resolves normally.
  .then(() => require('../utils/classSchedule').backfillClassRosterDates());
// A failure here (bad DATABASE_URL, unreachable database, a schema file
// that doesn't parse) means the app can never serve a correct response -
// worth logging loudly regardless of context. Deciding what to *do* about
// it (crash a real standalone server vs. let a Netlify Function's request
// fail normally vs. let a test see the rejection) is server.js's call, not
// this module's - it has no way to know which of those it's running
// under, and calling process.exit() here directly would kill a test
// process or a Netlify Function's warm container just as readily as a
// real server (see server.js's own IS_MAIN_PROCESS for the full story).
// server.js's bootReady already chains off this same promise and decides
// there.
db.ready.catch((err) => {
  console.error('Database failed to initialize:', err);
});

module.exports = db;
