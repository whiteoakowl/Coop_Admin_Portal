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
//      `RETURNING id` to any bare INSERT (every table's primary key here
//      is literally named `id`), so `.lastInsertRowid` keeps working
//      without touching the SQL text itself - but an INSERT that already
//      has its own RETURNING clause is left alone.
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
function wrapQueryable(queryable) {
  function prepare(sql) {
    const text = toPgPlaceholders(sql);
    const runText = isBareInsert(text) ? `${text} RETURNING id` : text;
    return {
      async get(...params) {
        const res = await queryable.query(text, params);
        return res.rows[0];
      },
      async all(...params) {
        const res = await queryable.query(text, params);
        return res.rows;
      },
      async run(...params) {
        try {
          const res = await queryable.query(runText, params);
          return {
            lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined,
            changes: res.rowCount,
          };
        } catch (err) {
          // A handful of tables (app_settings, name_tag_templates,
          // misc_badge_templates, sessions, ...) are keyed by their own
          // natural key, not a surrogate `id` column - the auto-appended
          // `RETURNING id` above assumes every table has one, which isn't
          // true for those. Rather than hardcoding that table list here
          // (and it silently drifting out of sync with the schema), retry
          // the original statement with no RETURNING clause whenever
          // Postgres reports specifically that `id` doesn't exist -
          // .lastInsertRowid just comes back undefined for these, same as
          // it would for any SQLite insert nothing ever reads it from.
          if (runText !== text && err.code === '42703') {
            const res = await queryable.query(text, params);
            return { lastInsertRowid: undefined, changes: res.rowCount };
          }
          throw err;
        }
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
function createPgDb(connectionString) {
  const pool = new Pool({ connectionString });
  const base = wrapQueryable(pool);

  base.withTransaction = async (fn) => {
    const client = await pool.connect();
    const tx = wrapQueryable(client);
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
function createPgliteDb(pglite) {
  const base = wrapQueryable(pglite);

  base.withTransaction = (fn) =>
    pglite.transaction(async (tx) => fn(wrapQueryable(tx)));

  base.end = () => pglite.close();
  return base;
}

module.exports = { createPgDb, createPgliteDb, wrapQueryable, toPgPlaceholders, isBareInsert };
