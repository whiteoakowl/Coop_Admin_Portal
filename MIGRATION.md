# Supabase/Netlify migration — status and handoff notes

This document exists so a fresh Claude Code session (or a human) can pick this
migration up with zero prior context. Read this first before touching any of
the files it references.

## Why this exists

The app currently stores everything (member data, attendance, everything) in
a single SQLite file on local disk. The user wants to deploy through GitHub +
Netlify, and Netlify gives a deployed app no persistent local disk at all —
every request/deploy gets a fresh, empty filesystem. So the goal is:

- Move all data storage to **Supabase** (hosted Postgres + Storage) — code
  stays in GitHub, data lives entirely outside it, so redeploys can never
  touch it.
- Deploy the app to **Netlify** as a serverless Function wrapping the
  existing Express app (URLs stay the same).
- Keep the existing admin login model (shared Admin/Co-op Admin accounts via
  env vars) — **not** migrating to Supabase Auth (explicit user decision).
- RLS enabled on every table as defense-in-depth, but the server always
  connects with a privileged key that bypasses it — the browser never talks
  to Supabase directly in this app.
- Do this as a **phased, tested migration on a separate branch**
  (`supabase-migration`, branched off the feature branch that has all the
  app's current functionality — NOT off `main`, which is behind). Nothing
  merges anywhere until it's fully proven.

## Branch / repo state

- Repo: `whiteoakowl/sh-check-in-out` (GitHub shows a redirect notice to
  `whiteoakowl/Coop_Admin_Portal` — same repo, just renamed; both remote URLs
  work).
- This work lives on branch **`supabase-migration`**, branched from
  `claude/multi-account-repo-setup-wpi4qo` (the feature branch backing PR #51,
  itself not yet merged to `main`).
- **No PR has been opened for `supabase-migration` and nothing has been
  merged anywhere.** The live app (whatever's on `main`) is completely
  unaffected by any of this.

## Supabase project setup (already done by the user)

- Two Supabase projects created, GitHub-connected during creation:
  production project (unnamed as of this writing, not yet configured) and a
  **dev/test project**.
- The dev project's schema has been applied and confirmed by the user
  (Table Editor shows ~42 tables) — via manually running
  `supabase/migrations/20260811035644_initial_schema.sql` in the Supabase
  SQL Editor (the GitHub integration's auto-apply either wasn't configured
  for the right branch or hadn't triggered yet — worth checking
  Project Settings → Integrations → GitHub if this needs to happen again for
  a future migration file).
- **Environment variables needed** (a `.env` file in the repo root — never
  committed, already gitignored):
  ```
  DATABASE_URL=<dev project's Transaction pooler connection string, password percent-encoded>
  SUPABASE_URL=<dev project's URL>
  SUPABASE_ANON_KEY=<dev project's publishable/anon key>
  SUPABASE_SERVICE_ROLE_KEY=<not yet obtained - needed before utils/storage.js can actually upload anything>
  ```
  These live only in the local `.env` file of whichever session is doing the
  work — **a fresh session/container will NOT have this file** even on the
  same account, since it's gitignored by design (it holds real secrets). The
  user has these values from their Supabase dashboard (Project Settings →
  Database → Connect, and Project Settings → API) and can re-provide them to
  any new session that needs them. `SUPABASE_SERVICE_ROLE_KEY` specifically
  has not been collected yet — needed for `utils/storage.js` to actually work
  (Storage writes require it, not the anon key).

### A real environment constraint hit during this work

**This specific sandboxed session's outbound network is restricted to an
allowlist that does NOT include `*.supabase.co` or Supabase's Postgres
pooler hosts** — confirmed by direct testing (raw TCP connect and HTTPS
requests to Supabase both fail/reset). This means:
- I could never test a real connection to the user's actual Supabase project
  from this environment, regardless of how correct the connection string was.
- All automated tests instead run against **PGlite** (`@electric-sql/pglite`,
  a real embedded Postgres compiled to WASM, runs fully in-process) — see
  `test/pgTestDb.js`. This is a legitimate, well-regarded way to test
  Postgres-target code without Docker or network access, and every test in
  this migration exercises real Postgres behavior (not mocks), just not the
  user's specific hosted instance.
- Docker is also present but its daemon cannot start in this sandbox
  (`ulimit: Operation not permitted`) — so the Supabase CLI's local dev stack
  (`supabase start`) doesn't work here either, hence the pivot to PGlite.
- **A future session should check whether ITS environment can reach
  `supabase.co`** — if so, real connection testing against the dev project
  becomes possible and should be done (see "Suggested next steps" below).
  Don't assume the same restriction applies elsewhere.

## What's done so far (all committed to `supabase-migration`, all tested)

1. **`supabase/migrations/20260811035644_initial_schema.sql`** — full
   Postgres translation of `db/schema.sql` (all 42 tables, every
   column/constraint preserved 1:1). Applied and confirmed live in the dev
   Supabase project. Translation notes are in the file's own header comment
   (identity columns, the `now_text()` timestamp-format-matching helper,
   which columns needed `bigint` instead of `integer`, RLS enabled
   default-deny on every table via a `DO` block at the end).

2. **`db/postgres.js`** — the async replacement for `db/index.js`'s
   synchronous `node:sqlite` calls. Exposes the same
   `.prepare(sql).get()/.all()/.run()` shape (now returning Promises) so
   migrating a route file is mostly "add `await`, make the handler `async`"
   rather than a query-by-query rewrite. Handles `?` → `$1,$2,...` placeholder
   translation and auto-appends `RETURNING id` to bare INSERTs (with a
   fallback retry for the handful of tables keyed by a natural key instead of
   a surrogate `id` — `app_settings`, `name_tag_templates`,
   `misc_badge_templates`, `sessions`). **Read this file's own header comment
   before migrating any route file** — it explains the one real behavioral
   difference (`db.withTransaction(fn)` now passes `fn` a
   transaction-scoped handle that every query inside the transaction must go
   through, not the outer `db`).

3. **`db/bootstrapPg.js`** — first-boot seeding for a *brand new* Postgres
   database (default admin account, Class Check-In PIN, starter badge/
   schedule-card templates, etc.). Deliberately does NOT port `db/index.js`'s
   "One-time backfill/upgrade" blocks — those only exist to upgrade an
   already-deployed SQLite database and have nothing to migrate on a fresh
   Postgres install.

4. **`utils/pgSessionStore.js`** — Postgres-backed express-session Store,
   replacing `utils/sqliteSessionStore.js`. Not yet wired into `server.js`.

5. **`utils/storage.js`** — Supabase Storage wrapper for the eventual
   replacement of every route's local-disk `multer.diskStorage()` (member
   photos, name tag/schedule card design images, documents). Not yet wired
   into any route. Needs `SUPABASE_SERVICE_ROLE_KEY` to actually function -
   not yet obtained (see above).

6. **Tests**: `test/dbPostgres.test.js`, `test/pgSessionStore.test.js`,
   `test/storage.test.js`, plus the shared `test/pgTestDb.js` helper. All run
   as part of the normal `npm test` (355 tests total across the whole repo,
   all passing as of the last commit on this branch). `npm run lint` and
   `npm run lint:css` also clean.

## What's NOT done yet — the actual remaining work

1. **The big one: migrate every route file off synchronous SQLite calls.**
   ~24 files in `routes/`, plus every `utils/*.js` module that does
   `db.prepare(...)`. This is the largest remaining piece by far. Approach:
   one file at a time, convert its DB calls to the new async shape, add
   route-level tests (or confirm existing ones still pass) using
   `test/pgTestDb.js` instead of a real SQLite file, commit each file (or a
   small logical group of related files) separately rather than attempting
   all 24 in one shot. Grep for `db.prepare(` to find every call site still
   needing conversion — that grep should return zero results in `routes/`
   and `utils/` once this is done (excluding the untouched SQLite files
   themselves, which stay as-is until final cutover).

2. **Wire `utils/pgSessionStore.js` and `utils/storage.js` into the actual
   app** (`server.js`'s `session()` config, and each of the 5 route files
   using `multer.diskStorage()` — see `db/postgres.js`'s sibling comment
   trail for the exact list: `routes/admin-documents.js`,
   `routes/admin-members.js`, `routes/admin-name-tag.js`,
   `routes/admin-schedule.js`, `routes/membership.js`). Needs
   `SUPABASE_SERVICE_ROLE_KEY` first.

3. **Netlify deployment config** — wrap the Express app with `serverless-http`
   as a Netlify Function, `netlify.toml` redirect rules so every existing URL
   keeps working, env var wiring for the *production* Supabase project
   (different from the dev one used so far).

4. **One-time production data export/import** — once everything above is
   tested and ready to cut over, export the live SQLite data and import it
   into the production Supabase project's Postgres schema. Not started; no
   production Supabase project has been configured yet (only the dev one has
   the schema applied).

5. **`db/index.js` (the SQLite version) gets deleted, and `db/postgres.js`
   gets promoted to be `db/index.js`** — the very last step, once every route
   file is converted and the whole test suite is green using ONLY the
   Postgres path. Until then, both coexist deliberately (the SQLite version
   is what the live `main`/production app still runs on).

## Suggested next steps for whoever picks this up

1. Read this file, then skim the "What's done" file list above to get
   oriented.
2. Check whether your session's environment can reach `supabase.co` (try
   `curl -sS -o /dev/null -w '%{http_code}\n' https://supabase.co`) — if
   yes, ask the user for the dev project's connection details again (they'll
   need to re-share them; nothing carries over) and do a **real** connection
   test before continuing, strictly better than this session's PGlite-only
   verification.
3. Also ask the user for `SUPABASE_SERVICE_ROLE_KEY` if it's needed for the
   next piece of work (Storage wiring specifically).
4. Continue the route-file migration one file at a time, in whatever order
   seems natural — there's no dependency ordering between most of them
   except that anything gating on `req.session.adminId` implicitly depends
   on the session store actually being wired in first if you want to test it
   end-to-end through real HTTP requests (route-level tests can still use
   `test/pgTestDb.js` directly without that, the way `test/dbPostgres.test.js`
   and `test/pgSessionStore.test.js` already do).
5. Keep committing and pushing to `supabase-migration` after each real,
   tested chunk of progress — don't let uncommitted work pile up in one
   giant, harder-to-review change.
