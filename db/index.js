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
const { seedIfMissing } = require('./bootstrapPg');

const SCHEMA_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260811035644_initial_schema.sql');

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
  const pglite = process.env.DB_PATH ? new PGlite() : new PGlite(path.join(__dirname, '..', 'data', 'pglite'));
  schemaReady = (async () => {
    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await pglite.exec(schemaSql);
  })();
  db = createPgliteDb(pglite, schemaReady);
}

db.ready = schemaReady.then(() => seedIfMissing(db));
// A failure here (bad DATABASE_URL, unreachable database, a schema file
// that doesn't parse) means the app can never serve a correct response -
// fail loudly and immediately rather than limping along with every
// request hanging on a promise that'll never resolve.
db.ready.catch((err) => {
  console.error('Database failed to initialize:', err);
  process.exit(1);
});

module.exports = db;
