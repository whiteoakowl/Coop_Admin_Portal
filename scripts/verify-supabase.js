// One-off diagnostic: confirms this machine can actually reach the
// Supabase project named in .env, independent of the app itself. Run this
// BEFORE trusting any other Supabase-dependent work (the DB driver
// cutover, wiring utils/storage.js into routes) - `npm test` alone does
// NOT prove real connectivity, since the test suite runs against an
// in-process PGlite instance (see test/pgTestDb.js), never the network.
//
// Usage:
//   node scripts/verify-supabase.js
//
// Needs a .env in the repo root (see .env.example) with at least
// DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY set. SUPABASE_SERVICE_ROLE_KEY
// is optional here - if it's missing, the Storage check is skipped rather
// than failing, since Storage wiring is a separate, later step.
require('dotenv').config();
const { createPgDb } = require('../db/postgres');

function checkEnv() {
  const required = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required .env value(s): ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill these in from your Supabase dashboard first.');
    process.exit(1);
  }
}

async function checkPostgres() {
  console.log('--- Postgres (DATABASE_URL) ---');
  const db = createPgDb(process.env.DATABASE_URL);
  try {
    const ok = await db.prepare('SELECT 1 AS ok').get();
    if (!ok || ok.ok !== 1) throw new Error('Unexpected response to a trivial SELECT 1');
    console.log('Connected.');

    const tableCount = await db.prepare(
      "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public'"
    ).get();
    console.log(`Found ${tableCount.c} table(s) in the public schema (expect ~42 once the migration SQL has been applied).`);

    const admin = await db.prepare('SELECT username FROM admins LIMIT 1').get();
    console.log(admin ? `Seed data present - admin username "${admin.username}" exists.` : 'No admin row found yet (expected on a brand-new database before first boot seeding runs).');

    return true;
  } catch (err) {
    console.error('Postgres check FAILED:', err.message);
    return false;
  } finally {
    await db.end();
  }
}

async function checkStorage() {
  console.log('\n--- Supabase Storage (SUPABASE_SERVICE_ROLE_KEY) ---');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('SUPABASE_SERVICE_ROLE_KEY not set - skipping (only needed once utils/storage.js gets wired into upload routes).');
    return true;
  }
  const { createStorageClient } = require('../utils/storage');
  const client = createStorageClient();
  try {
    const { data, error } = await client.storage.listBuckets();
    if (error) throw error;
    console.log(`Reachable. Bucket(s): ${data.length ? data.map((b) => b.name).join(', ') : '(none created yet)'}`);
    return true;
  } catch (err) {
    console.error('Storage check FAILED:', err.message);
    return false;
  }
}

(async () => {
  checkEnv();
  const pgOk = await checkPostgres();
  const storageOk = await checkStorage();
  console.log('\n' + (pgOk && storageOk ? 'All checks passed.' : 'One or more checks failed - see above.'));
  process.exit(pgOk && storageOk ? 0 : 1);
})();
