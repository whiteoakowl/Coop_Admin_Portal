// Shared test helper for the Postgres-backed migration: boots a fresh,
// isolated PGlite instance (in-process, WASM-compiled real Postgres - no
// Docker, no network, no shared state between test files), applies the
// same schema migration file Supabase itself would apply, and runs the
// same first-boot seeding db/bootstrapPg.js runs against a real
// production database. Mirrors how every existing *.test.js file gets its
// own fresh, throwaway SQLite file via DB_PATH - same isolation
// guarantee, different engine.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { createPgliteDb } = require('../db/postgres');
const { seedIfMissing } = require('../db/bootstrapPg');

const SCHEMA_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260811035644_initial_schema.sql');

async function createTestDb({ seed = true } = {}) {
  const pglite = new PGlite();
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await pglite.exec(schemaSql);

  const db = createPgliteDb(pglite);
  if (seed) await seedIfMissing(db);

  return db;
}

module.exports = { createTestDb };
