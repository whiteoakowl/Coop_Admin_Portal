// The Postgres/Supabase replacement for db/index.js's synchronous
// node:sqlite DatabaseSync - see MIGRATION.md for the full story on why
// this exists and how it's being rolled out.
//
// Every route file currently does:
//   const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
// synchronously. A real network Postgres connection can't be synchronous,
// so the equivalent here is:
//   const row = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
// - same shape, same `?` placeholders (translated to Postgres's `$1, $2, ...`
// under the hood), just `await`ed. That's the whole point of keeping the
// call shape this close to the original: migrating a route file is mostly
// "add `await`, make the handler `async`", not a rewrite of every query.
//
// Two things are NOT just "add await", and need actual attention wherever
// they show up in a route file:
//
//   1. `.run()` on an INSERT that reads `.lastInsertRowid` afterward.
//      SQLite hands that back for free; Postgres only will if the
//      statement has a RETURNING clause. This module auto-appends
//      `RETURNING id` to any bare INSERT targeting a table that actually
//      has an `id` column (checked once via information_schema.columns,
//      cached - see tableHasIdColumn below; a handful of tables are keyed
//      by their own natural/composite key instead), so `.lastInsertRowid`
//      keeps working without touching the SQL text itself - but an INSERT
//      that already has its own RETURNING clause is left alone.
//
//   2. `db.withTransaction(fn)`. The old version needed no argument - the
//      whole app has exactly one, single-threaded, synchronous SQLite
//      connection, so `fn` calling `db.prepare(...)` inside a transaction
//      just used that same connection. A pooled/networked Postgres
//      connection doesn't work that way: statements inside a transaction
//      MUST run on the one specific connection that issued BEGIN, not
//      whichever connection the pool happens to hand out next. So here,
//      `withTransaction(fn)` passes `fn` a transaction-scoped db handle
//      (same `.prepare().get/.all/.run` shape) - every query inside the
//      transaction has to go through THAT handle, not the outer `db`:
//
//        await db.withTransaction(async (tx) => {
//          await tx.prepare('...').run(...);   // right - uses the tx's own connection
//          await db.prepare('...').run(...);   // WRONG - different connection, not part of the transaction
//        });
const { Pool } = require('pg');

function isBareInsert(sql) {
  return /^\s*insert\s/i.test(sql) && !/\breturning\b/i.test(sql);
}

function insertTableName(sql) {
  const m = /^\s*insert\s+into\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(sql);
  return m ? m[1] : null;
}

// A handful of tables (app_settings, name_tag_templates,
// misc_badge_templates, sessions, roster_dates, class_enrollments, ...)
// are keyed by their own natural/composite key, not a surrogate `id`
// column, so auto-appending `RETURNING id` to their INSERTs would fail.
// Whether a table has one is checked once via information_schema.columns
// and cached for the life of the process (schemas don't change at
// runtime) - decided BEFORE the INSERT ever runs, not discovered by
// trying it and catching the error: a failed statement inside a
// transaction poisons the whole transaction (Postgres error 25P02,
// "current transaction is aborted, commands ignored until end of
// transaction block"), so a same-transaction retry would fail too,
// masking the real error - confirmed the hard way, see MIGRATION.md.
const idColumnCache = new Map();

async function tableHasIdColumn(queryable, tableName) {
  if (idColumnCache.has(tableName)) return idColumnCache.get(tableName);
  // Scoped to table_schema = 'public' - information_schema.columns spans
  // every schema in the database, and a real Supabase project always has
  // its own auth schema alongside this app's tables (auto-provisioned for
  // Supabase Auth, even though this app doesn't use it - see MIGRATION.md).
  // auth.sessions is a real table there with its own id column, so an
  // unscoped lookup for "a table named sessions with an id column" matched
  // that instead of this app's own public.sessions (which has none),
  // wrongly appending RETURNING id to every session write and breaking
  // login. Invisible against PGlite in every test, since a fresh PGlite
  // instance only ever has the public schema this app's own migration
  // creates - no auth schema to collide with.
  const res = await queryable.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'", [
    tableName,
  ]);
  const has = res.rows.length > 0;
  idColumnCache.set(tableName, has);
  return has;
}

// SQLite's `?` positional placeholders -> Postgres's `$1, $2, ...`. Every
// query in this codebase uses `?` exclusively (never named params, never a
// literal `?` character inside a string literal), so a straight sequential
// replace is safe - no SQL parsing needed.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wraps anything with an async `query(text, params) -> { rows, rowCount }`
// method (a `pg` Pool, a checked-out `pg` Client, or a PGlite/PGlite
// transaction handle - they're API-compatible for this) into the
// `.prepare(sql).get/.all/.run(...)` shape every route file already uses.
//
// `ready` (optional, defaults to an already-resolved promise) is awaited
// before every .get/.all/.run - see db/index.js's own header comment for
// why: a fresh PGlite instance has no tables until its schema is applied,
// and that's necessarily async, so every existing `await
// db.prepare(sql).get()` call site across the whole app transparently
// waits for that instead of racing it, with zero changes needed at those
// call sites. Deliberately gates on schema-readiness only, not full
// first-boot seeding - see db/index.js for why that distinction matters.
function wrapQueryable(queryable, ready = Promise.resolve()) {
  function prepare(sql) {
    const text = toPgPlaceholders(sql);
    const runText = isBareInsert(text) ? `${text} RETURNING id` : text;
    return {
      async get(...params) {
        await ready;
        const res = await queryable.query(text, params);
        return res.rows[0];
      },
      async all(...params) {
        await ready;
        const res = await queryable.query(text, params);
        return res.rows;
      },
      async run(...params) {
        await ready;
        // isBareInsert() (runText !== text) means this INSERT has no
        // RETURNING clause of its own yet - decide whether to auto-append
        // `RETURNING id` based on whether the target table actually has
        // one. An INSERT that already supplies its own RETURNING clause
        // (runText === text) is always sent as-is; .id is still read from
        // whatever row it hands back below, same as the auto-appended case.
        let finalText = text;
        if (runText !== text) {
          const tableName = insertTableName(text);
          const hasId = tableName ? await tableHasIdColumn(queryable, tableName) : false;
          if (hasId) finalText = runText;
        }
        const res = await queryable.query(finalText, params);
        return {
          lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined,
          // A real `pg` Pool/Client always sets `rowCount`. PGlite (local
          // dev + every test) instead sets `affectedRows` and leaves
          // `rowCount` undefined - confirmed directly against PGlite, not
          // just inferred from a failing test. Fall back to it so `.changes`
          // reports the real number of affected rows under both backends.
          changes: res.rowCount !== undefined ? res.rowCount : res.affectedRows,
        };
      },
    };
  }

  async function exec(sql) {
    await queryable.query(sql);
  }

  return { prepare, exec, query: (text, params) => queryable.query(text, params) };
}

// Production/dev: a real Postgres connection (Supabase or otherwise) via a
// connection pool. `connectionString` should be Supabase's *pooled*
// connection string (the "Transaction" or "Session" pooler URL from
// Project Settings > Database), not the direct one - serverless functions
// open/close connections far more often than a long-running server would,
// which is exactly what the pooler is for.
function createPgDb(connectionString, ready) {
  const pool = new Pool({ connectionString });
  const base = wrapQueryable(pool, ready);

  base.withTransaction = async (fn) => {
    const client = await pool.connect();
    const tx = wrapQueryable(client, ready);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  base.end = () => pool.end();
  return base;
}

// Test suite: an in-process PGlite instance (see test/pgTestDb.js) - no
// real network connection, no Docker, a fresh isolated database per test
// file. PGlite has no connection pool (it's a single embedded engine), and
// its own `.transaction()` already handles BEGIN/COMMIT/ROLLBACK correctly
// for it - delegated to directly rather than reimplementing that here.
function createPgliteDb(pglite, ready) {
  const base = wrapQueryable(pglite, ready);

  base.withTransaction = (fn) =>
    pglite.transaction(async (tx) => fn(wrapQueryable(tx, ready)));

  base.end = () => pglite.close();
  return base;
}

module.exports = { createPgDb, createPgliteDb, wrapQueryable, toPgPlaceholders, isBareInsert };
