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
   as part of the normal `npm test` (374 tests total across the whole repo,
   all passing as of the last commit on this branch). `npm run lint` and
   `npm run lint:css` also clean.

7. **Route files/utils converted to async/await so far** (item 1 under
   "What's NOT done yet" below - keep this list updated as more get done,
   so nobody has to re-grep the whole repo to find where this left off):
   - `routes/contact-admins.js` — fully converted
   - `routes/admin-schedule.js` — fully converted (also fixed 3
     `COLLATE NOCASE` → `LOWER()`)
   - `routes/membership.js` — fully converted (per-child insert loop
     changed `forEach` → `for...of` so each insert can be awaited)
   - `routes/name-tag.js` — fully converted
   - `utils/memberLookup.js` + `routes/kiosk-class-checkin.js` — fully
     converted (see the `datetime('now')` and test-file special-case
     writeups above, both discovered while converting these)
   - `utils/search.js` + `routes/admin-search.js` — fully converted, 2
     `COLLATE NOCASE` fixed
   - `utils/setup.js` + `routes/admin-setup.js` + `routes/setup.js` —
     fully converted, 1 `COLLATE NOCASE` fixed
   - `utils/taskList.js` — fully converted, completing
     `routes/admin-setup.js`; added test coverage that didn't exist
     before (`test/routes-admin-setup-tasks.test.js`)
   - `utils/designImageGC.js` — fully converted (both call sites)
   - `utils/scheduleCardData.js` — `getScheduleCardTemplate()` converted
     (the only function in it that touches the db directly -
     `scheduleCardDataForMember` stays sync, see the coupling note below)
   - `routes/kiosk.js` — fully converted (both scan endpoints; its own
     `datetime('now')` upsert left untouched, deferred per the
     special-cases list)
   - `utils/nameTagData.js` — fully converted (`cleanupTeamsForParent`,
     `badgeDataForMember`, `getTemplate`)
   - `routes/admin-name-tag.js` — fully converted (last 4
     `COLLATE NOCASE` in the file fixed too)
   - `routes/admin-design.js` — **fully** converted (the `GET /design`
     handler, `nameTagSubmissions()`, the requests export/archive/
     unarchive routes, and `print-both`/`print-duplex`).
   - `routes/admin-members.js` — **fully** converted (every handler and
     every local helper function -
     `attendanceHistoryForMember`/`syncCleanupTeams`/
     `clearVolunteerMembershipIfNotParent`/`ensureFamilyForParent`/
     `allSetupTeams`/`cleanupTeamIdsForMember`/`createFamilyFromLastName`/
     `createOrLinkFamilyMember` - plus every `COLLATE NOCASE` in the file
     fixed). This was the single biggest remaining route file; see the
     regression writeup below for why it needed a full pass rather than a
     partial one.
   - `utils/members.js` — **fully** converted, every exported db-touching
     function (`findMemberByName`, `activeParentOptions`, `familyOf`,
     `hasInfantChild`, `familyGroupsByParent`, `loadFamilyMember`,
     `allFamilies`, `setMemberFamily`, `setPrimaryParent`,
     `membersWithMedicalNotes`, `rostersForMember`, `rostersByMemberIds`,
     `teacherMemberIds`, `membersWithDetails`, `generateMemberCode`), 8
     `COLLATE NOCASE` fixed. `lastNameOf`/`byLastName`/
     `sortMembersByFamily` stay plain sync helpers (no db access).
   - `utils/schedule.js` — **fully** converted (`getMemberSchedule`,
     `arrivalDepartureLabels`, `scheduleList`), including the
     `scheduleCardData.js` ripple flagged below.
   - `utils/scheduleCardData.js` — **fully** converted
     (`scheduleCardDataForMember` and `primaryParentFor`, on top of the
     `getScheduleCardTemplate()` conversion from earlier).
   - `utils/rosterGrid.js` — **fully** converted (`rosterMembers`,
     `rosterDates`, `buildRosterGridData`).
   - `utils/cardPairs.js` — **fully** converted (`buildCardPairs`) - this
     one was a genuine regression (see below), not routine follow-on work.
   - `routes/name-tag.js` — **fully** converted (both handlers; the
     `members.map(loadFamilyMember)` loop restructured to a `for...of` so
     each lookup can be awaited).
   - `routes/absence.js`, `routes/kiosk.js`, `routes/kiosk-class-
     checkin.js` — **fully** converted for every call site that touches
     the functions above (both `absence.js` handlers; `kiosk.js`'s
     `find-parent/scan`; `kiosk-class-checkin.js`'s attendance view).
   - `routes/admin-schedule.js` — **fully** converted (every
     `scheduleList`/`getMemberSchedule` call site, plus `GET
     /schedule/export.csv` and `GET /schedule/print`, which weren't
     `async` before at all).
   - `routes/admin-setup.js`, `routes/admin-volunteers.js` — **partially**
     converted: only the specific handlers forced to change by the
     `utils/members.js`/`utils/rosterGrid.js` conversions above (4
     handlers in `admin-volunteers.js`: `/volunteers/:day/manage`,
     `/volunteers/:day/teams`, `/volunteers/:day/teams/export.csv`, the
     import loop's `findMemberByName` call; 1 more `activeParentOptions()`
     await in `admin-setup.js`). Both files still have plenty of their
     own untouched `db.prepare(` calls.
   - `routes/admin-rosters.js` — **partially** converted: only
     `buildDaySnapshot()`, `archiveDay()`, `POST /rosters/:day/archive`,
     `GET /rosters`, and `GET /roster/:tab/export.csv` (all forced by the
     `rosterGrid.js` conversion). Still has its own `withTransaction` +
     `INSERT OR` untouched, deliberately - see "not yet started" below.
   - `routes/admin-logs.js` — **partially** converted: only `GET /logs`'s
     `allergies` tab branch and the 3 `/logs/allergies/*` routes (forced
     by `membersWithMedicalNotes()` becoming async). The rest of the file
     (checkinout/nametag/absence/classrisk/substitutes tabs, and its own
     duplicate `nameTagSubmissions()`) is still fully synchronous,
     deliberately untouched.
   - `utils/substitutes.js` — **not** converted to async. Instead,
     `assignedInfo()`'s call to the now-async `hasInfantChild()` was
     replaced with a small local synchronous duplicate
     (`hasInfantChildSync`) that runs the same query directly, so this
     module stays 100% synchronous rather than pulling
     `substituteBoard`/`jobAssignmentGrid`/`dailyAssignmentCards*`/
     `pendingApprovalsForToday` (and their callers in
     `routes/volunteers.js`, `routes/admin-logs.js`,
     `routes/admin-volunteers.js`, `utils/alerts.js`) into a much bigger
     ripple than this pass needed. Still has its own `INSERT OR` +
     everything else untouched - a real conversion of this file still
     needs to happen later and should drop `hasInfantChildSync` in favor
     of the real (by-then-safe-to-await) `hasInfantChild` again.

   **A real regression chain, not just routine follow-on work - read this
   if you're about to convert a widely-imported `utils/*.js` file**:
   converting `utils/members.js` broke callers that weren't touched in
   the same pass, in two ways that only surfaced via `npm test`'s full
   run, not via `node -c` or eslint:
   1. A grep sweep that only checked `routes/*.js` and `test/*.js` missed
      `utils/cardPairs.js`'s own call into `utils/nameTagData.js`'s
      already-async functions from an *earlier* session pass - a
      util-to-util call site, not a route. **Grep `utils/` too, every
      time**, not just `routes/` and `test/`.
   2. `routes/admin-members.js` called `generateMemberCode()` (and 6
      other now-async `utils/members.js` functions) synchronously at 13+
      sites; this wasn't caught until `npm test` produced a real runtime
      `TypeError: Provided value cannot be bound to SQLite parameter N`
      inside `createOrLinkFamilyMember` (a Promise was being bound as a
      SQL parameter). A handful of other stray sync call sites turned up
      the same way in `routes/admin-design.js`
      (`membersWithDetails(...).filter is not a function`),
      `routes/name-tag.js` (`parents.find is not a function`), and
      `routes/admin-logs.js`'s allergies tab.

   **The actual lesson**: when a `utils/*.js` function that's imported
   from many places becomes `async`, a grep for its name across the
   *entire* repo (`routes/`, `utils/`, `test/` - all three, every time)
   is not optional busywork, it's the only thing that reliably finds
   every call site. `npm test`'s full run (not just the test file for
   whatever you're actively converting) is the backstop that catches
   what the grep still misses - which it will, so budget time for a
   second full-suite run after the "final" grep sweep looks clean, the
   way this session needed two.

   **Important coupling this session had to budget for**:
   `utils/schedule.js`'s `getMemberSchedule()` is called by
   `utils/scheduleCardData.js`'s `scheduleCardDataForMember()`, which is
   in turn called from `routes/admin-schedule.js`, `routes/admin-
   members.js` (x2), and `routes/kiosk.js`. Converting `schedule.js`
   cascaded into `scheduleCardData.js`, which cascaded into re-touching
   every one of those call sites *again* to await
   `scheduleCardDataForMember(...)` itself (not just the
   `getScheduleCardTemplate()` calls already awaited there). Both are now
   done, but this is the shape to expect from any similarly central file.

   `utils/miscBadgeData.js` — **fully** converted (`getMiscTemplate`,
   `saveMiscTemplate`, `listMiscBadges`, `getMiscBadge`,
   `replaceMiscBadges`, `deleteMiscBadge`; 1 `COLLATE NOCASE` fixed;
   `saveMiscTemplate`'s `datetime('now')` deliberately left untouched).
   Forced follow-on awaits in `routes/admin-misc-badges.js` (fully
   converted), `routes/admin-design.js` (2 more awaits in `GET /design`),
   and `routes/admin-name-tag.js` (1 more await in the shared
   `/name-tag/template/:type` save route).

   **Not yet started** (direct `db.prepare(` call counts as of this
   writing - re-grep, these drift, and some of these earlier counts were
   undercounted due to the codebase's `db\n  .prepare(...)` line-break
   style not matching a same-line grep): `routes/admin.js`,
   `routes/admin-documents.js`, `routes/admin-library.js`,
   `routes/checkout.js`; the rest of `routes/admin-rosters.js` (has
   `withTransaction` x2 + `INSERT OR`), the rest of
   `routes/admin-volunteers.js` (has `withTransaction` + `INSERT OR`),
   the rest of `routes/admin-logs.js`, the rest of
   `routes/admin-setup.js`; and utils: `utils/backup.js` (1, `PRAGMA` -
   needs its own design, see below), `utils/classSchedule.js` (the
   biggest util file, has `withTransaction` x2 + `INSERT OR` x4 - heavily
   depended on by `admin-schedule.js`, `admin-rosters.js`,
   `admin-volunteers.js`, `kiosk-class-checkin.js`, `admin-logs.js` and
   others, so converting it means re-touching all of those call sites
   too), `utils/substitutes.js` (has `INSERT OR`, plus the
   `hasInfantChildSync` duplication above to clean up when it's
   converted), `utils/volunteers.js` (has `INSERT OR`).

   Suggested order for whoever picks this up: the two
   `withTransaction`-bearing giants next (`classSchedule.js`, then
   whatever routes still use it - this will finish off the remaining
   pieces of `admin-schedule.js`, `admin-rosters.js`,
   `admin-volunteers.js`, `admin-logs.js`, `kiosk-class-checkin.js` along
   the way), `substitutes.js`/`volunteers.js` together (both have `INSERT
   OR`, and converting `substitutes.js` is also the place to retire
   `hasInfantChildSync` back to the real `hasInfantChild`), and
   `backup.js` last (needs a real design decision, not just a mechanical
   pass - see below).

## What's NOT done yet — the actual remaining work

1. **The big one: migrate every route file off synchronous SQLite calls.**
   ~24 files in `routes/`, plus every `utils/*.js` module that does
   `db.prepare(...)`. This is the largest remaining piece by far, but a key
   discovery makes it much lower-risk than it sounds:

   **`await` on a value that isn't a Promise is a transparent no-op
   pass-through in JS** (confirmed with a throwaway test during this
   session - `await db.prepare(sql).get(x)` returns the exact same thing
   whether `db` is the *old, still-synchronous* SQLite object or the *new*
   async Postgres one). That means every route file can be converted to
   `async`/`await` **right now, before the actual database swap, with zero
   behavior change to the live app** - `server.js` keeps requiring
   `db/index.js` (still SQLite) the entire time this conversion is
   happening, and nothing breaks, because `await`-ing a synchronous return
   value just works. Express 5 (this app's version) also auto-catches
   rejected Promises from `async` route handlers, so no explicit try/catch
   wrapping is needed just to keep error handling working.

   This means: **the existing SQLite-backed test suite is the real safety
   net for each file's conversion** - after converting a route file, run
   the full existing suite (`npm test`) and it must stay 100% green,
   completely unchanged in what it asserts. That proves the conversion
   didn't change behavior. A pglite-based test is only extra-needed for
   files that hit genuine SQLite-vs-Postgres dialect differences (see
   below), not for routine "add await, make handler async" conversions.

   Practical approach: one file (or a small logical group) at a time -
   convert every `db.prepare(sql).get()/.all()/.run()` call to
   `await ...`, mark the containing route handler `async`, run `npm test`
   + `npm run lint`, commit. Grep for `db.prepare(` to find remaining call
   sites - note this grep will still match *already-converted* files too
   (the call shape is deliberately unchanged, just awaited now), so "done"
   means every call site has an `await` in front of it and sits inside an
   `async` function, not that the grep returns zero hits.

   **Special cases that need actual dialect fixes, not just await/async**
   (grep for these specifically - `grep -rn "INSERT OR \|withTransaction\|PRAGMA\|strftime(" routes utils`):
   - `db.withTransaction(fn)` call sites - `fn` must become `async (tx) => {...}`
     and every query inside must go through `tx.prepare(...)`, not the outer
     `db` - see `db/postgres.js`'s own header comment for the exact
     right/wrong example. `utils/classSchedule.js` has several of these
     (`setEnrollment`, `deleteClass`, others - grep it directly).
   - `INSERT OR IGNORE` / `INSERT OR REPLACE` - Postgres equivalent is
     `INSERT ... ON CONFLICT (col) DO NOTHING` / `ON CONFLICT (col) DO
     UPDATE SET ...` (needs an explicit conflict target and, for REPLACE,
     an explicit SET list - not a blind "replace" the same way SQLite's
     `OR REPLACE` works).
   - Any raw `PRAGMA` statement - SQLite-only, no Postgres equivalent
     needed (Postgres always enforces foreign keys when declared; there's
     no `PRAGMA table_info()` equivalent needed either, since nothing in
     this app introspects its own schema at runtime outside `db/index.js`
     itself, which isn't part of this list).
   - `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` used directly (not via
     `withTransaction`) - same transaction-connection-binding concern as
     `withTransaction` above; check whether any file does this outside
     `db/index.js`'s own `withTransaction` implementation.
   - **`COLLATE NOCASE`** (52 occurrences across 20 files as of this
     writing - `grep -rn "COLLATE NOCASE" routes utils`) - SQLite's
     built-in case-insensitive collation, used throughout for
     case-insensitive sorting (`ORDER BY name COLLATE NOCASE`) and
     equality (`WHERE name = ? COLLATE NOCASE`, duplicate-name checks
     etc). **Do not try to create a matching `NOCASE` collation in
     Postgres as a drop-in fix** - I tried this (`CREATE COLLATION nocase
     (provider = icu, locale = 'und-u-ks-level2', deterministic =
     false)`), and while it's a real, documented Postgres technique, it
     silently broke case-insensitive *equality* matching under PGlite even
     though case-insensitive *sorting* worked fine with it (`ORDER BY ...
     COLLATE NOCASE` returned correctly sorted rows; `WHERE name = ?
     COLLATE NOCASE` matched nothing). Whether that's a PGlite/WASM-ICU
     limitation specifically or a genuine Postgres behavior I'm not
     currently able to verify against a real server - either way, it's far
     too risky to build 20 files' worth of duplicate-detection and lookup
     logic on an unverified, exotic feature. **Use `LOWER(col) =
     LOWER(?)` for equality and `ORDER BY LOWER(col)` for sorting
     instead** - plain, boring, and behaves identically on both engines
     (SQLite's own `COLLATE NOCASE` is ASCII-only case-folding by default
     too, same as `LOWER()`, so this is a behavior-preserving rewrite, not
     a behavior change). Fix this in the same pass as each file's
     async/await conversion, not as a separate sweep - you're already
     touching every one of that file's queries anyway.
   - **`datetime('now')` used inline in application SQL** (17 occurrences
     across 10 files as of this writing - `grep -rn "datetime('now')"
     routes utils`; NOT the same as `db/schema.sql`'s column `DEFAULT
     (datetime('now'))` clauses, which the Postgres migration already
     handles via `now_text()` - see the schema file's own header comment).
     **Do not swap these to `now_text()` during the routine async/await
     pass** - I made this mistake converting `routes/kiosk-class-
     checkin.js` and caught it before committing: `now_text()` only
     exists in the Postgres schema, so writing it into a query that still
     runs against live SQLite (which is every file until the final
     cutover) throws "no such function: now_text" immediately, breaking
     the route outright - unlike the `await`-on-non-Promise trick, this
     one has no safe no-op form on the still-SQLite-backed app. Leave
     `datetime('now')` exactly as-is when doing a file's routine
     conversion pass; fix all 17 at once in a dedicated commit right
     before/during the actual `db/index.js` → `db/postgres.js` cutover,
     verified against pglite first. (An even more portable option worth
     considering then: compute the timestamp in JS - e.g. `new
     Date().toISOString().slice(0,19).replace('T',' ')` matches
     `now_text()`'s exact output format - and pass it as a bound
     parameter instead of relying on either engine's own "now" SQL
     function at all.)
   - **Converting a util function to `async` means grepping `test/` too,
     not just `routes/`/`utils/`.** Caught this converting
     `utils/memberLookup.js`: `test/memberLookup.test.js` calls
     `findMemberByBarcodeOrName` directly (not through an HTTP request),
     so making it `async` turned its return value into a Promise and every
     assertion in that test file broke, even though every real route
     call site was already fixed correctly. `npm test`'s full run is the
     only thing that actually catches this - running just the route-level
     test file for whatever you're converting isn't enough by itself.

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
