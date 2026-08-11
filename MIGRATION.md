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

   **This item is now effectively complete.** Every route file and every
   `utils/*.js` module has been converted to async/await, with exactly
   one deliberate exception:

   - `utils/backup.js` — **not** converted, on purpose. It has 1
     `PRAGMA integrity_check` call plus its own direct file-level
     validation logic (opens a candidate restore file as a throwaway
     SQLite connection to sanity-check it before staging) - this needs a
     real design decision for the Postgres world (there's no equivalent
     "open an arbitrary file as a temp connection and validate it" for a
     hosted Postgres instance), not a mechanical await pass. Left fully
     synchronous; `routes/admin.js`'s 4 call sites into it
     (`backupPackageBuffer`, `stageRestore`, `isRestoreStaged`,
     `cancelStagedRestore`) are correspondingly left unawaited too,
     documented inline in that file.
   - `routes/admin.js` — **fully** converted otherwise: `POST /login`,
     `todayStatsForType`/`previousSessionDate`/`statsWithTrends` (the
     dashboard's stat-computation helpers), the dashboard handler itself,
     and the whole `renderSettings`-based Settings flow (username,
     password, restore upload/cancel, class-checkin-pin).
   - `routes/admin-documents.js`, `routes/admin-library.js`,
     `routes/checkout.js` — **fully** converted (every handler).
   - `utils/library.js` — **fully** converted too (wasn't previously
     tracked in this file's per-file breakdown, but had its own
     `db.prepare(` calls forced by `admin-library.js`'s conversion):
     every exported function, `createLibraryType`'s `INSERT OR IGNORE`
     rewritten to `ON CONFLICT (name) DO NOTHING`, 3 `COLLATE NOCASE`
     fixed, `returnCheckout`'s `datetime('now')` deliberately left
     untouched.

   A final sweep (`grep -rn "db\.prepare" routes utils` minus
   `utils/backup.js`, cross-checked against every match being either
   `await db.prepare(...)` or a `return db.prepare(...)` inside an
   `async function`) confirms `utils/backup.js` is genuinely the only
   file left with an unconverted call - `npx eslint .` and the full test
   suite both clean/green.

   - `utils/volunteers.js` — **fully** converted (every exported
     function), including `addMemberToSection`'s `INSERT OR IGNORE`
     rewritten to `ON CONFLICT ... DO NOTHING`, 2 `COLLATE NOCASE` fixed.
     This was the last remaining `utils/*.js` file with any unconverted
     `db.prepare(` calls. Retired `utils/substitutes.js`'s
     `floaterMembersForHour` and `utils/classSchedule.js`'s
     `floaterMemberIdsForDay`/`syncMemberSchedulesForDay`'s
     `getListByDay`/`sectionsForList` calls back to real awaited calls (all
     3 had been left deliberately synchronous in earlier passes specifically
     because this file wasn't converted yet). Forced follow-on awaits
     across the rest of `routes/admin-volunteers.js` (every remaining
     `getListByDay`/`sectionsForList`/`datesForList`/`membersForSection`/
     `setSectionRank`/`removeMemberFromSection`/`addMemberToSection` call
     site) and `routes/volunteers.js` (the public floater-chart view).

   - `utils/classSchedule.js` — **fully** converted, both `withTransaction`
     call sites (`deleteClass`, `setEnrollment`) and all 4 `INSERT OR`
     sites rewritten to `ON CONFLICT ... DO NOTHING`/`DO UPDATE SET`
     (`class_enrollments`, `class_staff`, `roster_members` x2). Every
     `COLLATE NOCASE` in the file fixed. `syncMemberSchedulesForDay`'s
     `datetime('now')` deliberately left untouched.
   - `utils/substitutes.js` — **fully** converted (every exported
     function), retiring the `hasInfantChildSync` duplicate from the
     earlier `utils/members.js` pass back to the real (now-safe-to-await)
     `hasInfantChild`. `setJobFloaters`'s `INSERT OR IGNORE` rewritten to
     `ON CONFLICT ... DO NOTHING`.
   - `utils/classCheckinPin.js` — **fully** converted
     (`setClassCheckinPin`/`verifyClassCheckinPin`).
   - `routes/admin-class-schedule.js` — **fully** converted (every
     handler - this was the single biggest remaining route file, all of
     `getClass`/`createClass`/`updateClass`/`deleteClass`/`setEnrollment`/
     `addStaff`/`removeStaff` call sites, both import handlers' `COLLATE
     NOCASE` fixed).
   - `routes/admin-rosters.js` — **fully** converted (the rest of it,
     beyond the earlier archive-only pass): `rosterIdForTab`/
     `siblingRosterId` made async (both call `ensureDayRoster`), and
     every one of their callers - `dates/add`, `dates/:date/remove` (its
     own `withTransaction` converted to the `tx` pattern), `add-member`,
     `remove-member/:memberId`, `attendance`, plus `GET /rosters`'s
     `classesAtRiskForDay`/`classesNeedingStaffForDay`/`allClassesList`
     calls and `GET /roster/:tab/export.csv`.
   - `routes/admin-volunteers.js` — **fully** converted (every remaining
     handler: `manage`, `dates/:date/remove`'s `withTransaction`,
     `export.csv`, the whole Archive section, `risk`, `teams`,
     `teams/add-member`, `teams/:sectionId/hour-label`,
     `teams/:sectionId/members/:memberId/remove`, `teams/export.csv`,
     `import`).
   - `routes/admin-substitutes.js`, `routes/volunteers.js`,
     `utils/alerts.js` — **fully** converted (forced by `substitutes.js`
     becoming async: every permanent-job/assignment CRUD route, the public
     floater-chart view, and `todaysAlerts()`'s own board/absence/
     class-risk aggregation).
   - `routes/admin-logs.js`, `routes/admin-setup.js`, `routes/setup.js` —
     one more handler/await each (`substitutes` + `classrisk` tabs in
     `admin-logs.js`; `absentMemberIdsForDate` in the other two). Both
     `admin-logs.js` and `admin-setup.js` still have plenty of their own
     untouched `db.prepare(` calls elsewhere in the file.
   - `routes/kiosk-class-checkin.js` — 3 more awaits (`allClassesList` x2,
     `ensureDayRoster`), plus the PIN unlock route's `verifyClassCheckinPin`.
   - `routes/admin.js` — 1 more await (`todaysAlerts()` in the dashboard
     handler).

   **A `withTransaction` contract change, not just a mechanical pass**:
   converting `classSchedule.js`'s 2 `withTransaction` call sites (plus 3
   more found in `admin-rosters.js`/`admin-volunteers.js` that were still
   using the old no-argument form) required actually fixing
   `db/index.js`'s own `withTransaction` first - the SQLite version
   previously called `fn()` with no argument at all, while
   `db/postgres.js`'s version always passed a `tx` handle (see that file's
   own header comment on why: a pooled Postgres connection needs every
   query inside the transaction to run on the one connection that issued
   BEGIN, not the outer `db`). `db/index.js`'s `withTransaction` is now
   `async` and passes `db` itself as `tx` (SQLite only ever has the one
   connection, so `tx.prepare(...)` there is literally `db.prepare(...)`),
   matching the Postgres contract - every call site now reads
   `await db.withTransaction(async (tx) => { await tx.prepare(...)... })`
   and works unchanged against either driver.

   **A real, confirmed startup race, not a hypothetical one** - read this
   before converting anything else `server.js` depends on at module-load
   time: `server.js` seeds the 4 always-exist Monday/Wednesday
   Parent/Student rosters at boot via `utils/classSchedule.js`'s
   `ensureDayRoster`/`syncDayMemberRosters`. Those becoming `async` broke
   this in two distinct ways, both caught only by the full test suite
   (never by `node -c` or eslint):
   1. The original code fired all 4 `ensureDayRoster` calls via a bare
      `.forEach` with no `await` between them - once the function was
      async, all 4 calls raced each other's "does this roster already
      exist" check before any of their inserts had committed, creating
      *duplicate* rosters with the same name (caught via a real
      `roster archive` test failure - the archived snapshot was missing
      data because `buildDaySnapshot` and the test's own direct-SQL setup
      had each independently created and looked up *different* "Monday
      Students" rosters).
   2. Fixing that by making the seeding a real sequential `await` chain
      does NOT fully fix the deeper problem: `require('./server')` can't
      block on a `Promise`, so multiple `test/routes-*.test.js` files whose
      `test.before()` hooks insert rows referencing the well-known roster
      ids 1-4 *immediately* after requiring the module were still racing
      ahead of the async seeding chain (2 more real failures, both
      `FOREIGN KEY constraint failed`, in `test/routes-logs-pagination.
      test.js` and `test/routes-search.test.js`). Node's own scheduling
      does not guarantee the seeding chain's microtasks fully drain before
      a synchronously-registered `test.before()` hook runs.

   **The fix, and why it's not just a workaround**: `server.js`'s roster
   *existence* seeding now uses a small local synchronous helper
   (`ensureDayRosterSync`, duplicating `ensureDayRoster`'s two-query logic
   directly against `db.prepare(...).run()` with no `await`/`async`) so
   the 4 rosters are guaranteed to exist by the time `require('./server')`
   returns to its caller - true today because the live driver really is
   still synchronous SQLite underneath the async wrapper, same reasoning
   as the rest of this migration's "await on a non-Promise is a
   pass-through" trick, just applied in the other direction (a
   synchronous duplicate of an async function, used only where sync
   completion is a hard requirement). Roster *membership* sync
   (`syncDayMemberRosters`) has no such ordering requirement - nothing
   reads it before the first class/floater edit in a fresh database - so
   that piece is left calling the real async function, unawaited, at
   boot. **Whoever does the final `db/index.js` → `db/postgres.js` cutover
   needs to revisit this**: once the live driver is genuinely async
   Postgres, `ensureDayRosterSync`'s synchronous-completion guarantee no
   longer holds, and `server.js`'s own bootstrapping (not just this one
   seeding step) will need a real "wait for ready" contract - likely
   exporting a startup Promise that `test/routes-*.test.js` files await
   right after requiring the module, which is a call-site change across
   every one of those ~30 files, not a small fix.

8. **Netlify deployment config** (`netlify.toml` + `netlify/functions/app.js`)
    — wraps the existing Express `app` export in `serverless-http` (`binary:
    true`, needed for photo/document/PDF downloads to survive the
    Lambda-style response envelope intact) behind a catch-all rewrite, so
    every existing route/URL keeps working unchanged; static files actually
    present in `public/` at build time are served directly by Netlify's CDN
    without ever touching the function. Verified end-to-end (not just
    lint-clean) with a standalone script that invoked the exported
    `handler` directly against a simulated Netlify Lambda event and a
    throwaway SQLite DB: a real page returned 200 with the right HTML body,
    a nonexistent path returned 404. `eslint.config.js` needed
    `netlify/**/*.js` (and, for the item below, `scripts/**/*.js`) added to
    its server-side CommonJS glob - both were simply missing.
    `.env.example` documents the Supabase/Netlify env vars, commented out
    and explicitly scoped as not needed for a normal local/LAN install.
    **Not by itself a complete deployment** — see the file's own header
    comment: it still needs item 1 below (DB + Storage cutover) landed in
    the same deploy, or the function boots against a database/upload
    directory that doesn't persist between invocations.

9. **`scripts/migrate-to-supabase.js`** — the one-time production data +
    file export/import script, written and dry-run-verified against the
    real dev SQLite database (`node scripts/migrate-to-supabase.js
    --dry-run` correctly walked every upload directory and every one of
    the 41 migrated tables - the `sessions` table is deliberately excluded,
    see below - with accurate row/file counts), but **never run against a
    real Supabase project** - this sandboxed environment cannot reach
    Supabase at all (see "A real environment constraint hit during this
    work" above), so the actual Postgres-writing and Storage-uploading
    code paths are correct by careful reading and by successfully
    exercising every other part of the script, not by an end-to-end run
    against production infra. Whoever runs this for real should re-read it
    once first.

    What it does, in order:
    1. **Files → Storage.** Walks each of the 5 `public/uploads/*`
       subdirectories and uploads every file to a matching bucket, reusing
       the existing filename as the Storage key (not
       `utils/storage.js`'s `generateKey()` - that's for the app's own
       future new-upload path; reusing today's filename here means this
       step needs no separate old-name → new-key mapping table and is
       trivially safe to re-run, `upsert: true`). Bucket list (none of
       these buckets exist yet - create them in the Supabase dashboard
       before running this):

       | local directory              | bucket                     | public? |
       |-------------------------------|-----------------------------|---------|
       | `uploads/members`             | `member-photos`             | yes     |
       | `uploads/membership-children` | `membership-child-photos`   | yes     |
       | `uploads/name-tags`           | `name-tag-images`           | yes     |
       | `uploads/schedule-cards`      | `schedule-card-images`      | yes     |
       | `uploads/documents`           | `documents`                 | **no**  |

       `documents` is private on purpose:
       `routes/admin-documents.js` gates every document behind
       `requireFullAdmin`, and a public bucket would make that gate
       meaningless (anyone with the URL could read it, no login required).
       **Known gap**: as of this script, that route still serves documents
       from local disk (`res.sendFile`) - before this bucket is actually
       used in production, `utils/storage.js` needs a signed-URL (or
       server-side proxy-download) helper added, since it currently only
       has `publicUrl()`. Create the bucket private either way, so this
       can't be forgotten later.
    2. **Rows → Postgres**, in the 41-table foreign-key-safe order kept as
       an explicit, human-auditable list in the script (not computed by a
       runtime topological sort) - verified by hand against every
       `REFERENCES` clause in `db/schema.sql`. `sessions` is the one table
       intentionally excluded: it's express-session's own ephemeral login
       state, not data worth preserving across the cutover - every admin
       just logs back in once afterward. Every table copies over
       column-for-column (the Postgres schema is a verified 1:1 column
       translation of the SQLite one - see the migration file's own header
       comment), with two rewrites applied in flight:
       - `members.photo_path` / `membership_request_children.photo_path` /
         `documents.file_path` (today store a full local path like
         `/uploads/members/172...png`) get rewritten to the bare Storage
         key, matching `utils/storage.js`'s own documented convention that
         these columns should hold a key, with `publicUrl()` (or the
         still-to-be-built signed-URL helper, for `documents`) computing
         the actual URL at render time. **This only renders correctly
         once the upload routes/view templates are switched from
         `multer.diskStorage()`/`res.sendFile` to `utils/storage.js`
         (item 1 below) - that swap must land in the same deploy as
         running this script**, or photos/documents 404 until it does.
       - `name_tag_templates`/`misc_badge_templates`/
         `schedule_card_templates.layout_json` (a JSON array of
         positioned elements) has each `{ type: 'image', src:
         '/uploads/name-tags/...' }` element's `src` rewritten to the
         *full* public Storage URL, not a bare key - a deliberate, narrow
         exception to the bare-key convention above, because this `src` is
         consumed directly as a literal URL by client-side rendering code
         (the design editor's live preview, `public/js/name-tag-render-
         core.js` for on-screen preview and print) with no server-side
         "look up the key, call `publicUrl()`" step at render time the way
         a normal DB column has.
       Tables with `id integer generated always as identity primary key`
       (detected at runtime via `information_schema.columns.is_identity`,
       not a hardcoded list) get their rows inserted with `OVERRIDING
       SYSTEM VALUE` to preserve the original ids, followed by a
       `setval(pg_get_serial_sequence(...), max(id), ...)` reset so the
       next real app-driven INSERT doesn't collide with an imported id.
       The whole row-copy runs inside one Postgres transaction, and the
       script refuses to run at all if the target database isn't already
       empty (checked via a `families` row count) - it's a one-shot bulk
       load, not a merge; re-running against a partially-loaded database
       needs the target truncated back to empty first, not a second blind
       run.
    3. Supports `--dry-run` (no writes anywhere, just prints what would
       happen - needs no Supabase env vars at all), `--skip-files`, and
       `--skip-rows`, so the file and row migrations can be run and
       re-verified as two separate passes if needed.

## What's NOT done yet — the actual remaining work

1. **Wire `utils/pgSessionStore.js` and `utils/storage.js` into the actual
   app** (`server.js`'s `session()` config, and each of the 5 route files
   using `multer.diskStorage()` — see `db/postgres.js`'s sibling comment
   trail for the exact list: `routes/admin-documents.js`,
   `routes/admin-members.js`, `routes/admin-name-tag.js`,
   `routes/admin-schedule.js`, `routes/membership.js`). Needs
   `SUPABASE_SERVICE_ROLE_KEY` first. This swap has to land in the same
   deploy as running `scripts/migrate-to-supabase.js` (item 9 above) -
   that script rewrites `photo_path`/`file_path`/`layout_json` values to
   point at Storage, which only resolves correctly once these routes and
   their view templates actually read from Storage instead of local disk.
   Also add the private-bucket signed-URL (or proxy-download) helper
   `utils/storage.js` doesn't have yet, needed before `admin-documents.js`
   can serve the private `documents` bucket.

2. **Run `scripts/migrate-to-supabase.js` for real**, against the actual
   production SQLite file and a freshly-provisioned production Supabase
   project (distinct from the dev project used throughout this work) -
   the script itself is written and dry-run-verified (item 9 above), but
   has never touched a real Supabase project, since this sandboxed
   environment can't reach one. Create the 5 Storage buckets first (table
   above), then run without `--dry-run`.

3. **`db/index.js` (the SQLite version) gets deleted, and `db/postgres.js`
   gets promoted to be `db/index.js`** — the very last step, once item 1
   above is wired in and the whole test suite is green using ONLY the
   Postgres path (a pglite-backed run, at minimum, since this environment
   can't reach a real Postgres server either). Until then, both coexist
   deliberately (the SQLite version is what the live `main`/production app
   still runs on). Also revisit `server.js`'s `ensureDayRosterSync` startup
   fix at this point - see its own header comment and the "real, confirmed
   startup race" writeup above for why the synchronous-completion trick it
   relies on stops holding once the live driver is genuinely async
   Postgres.

## Suggested next steps for whoever picks this up

Every piece of this migration that can be built, tested, and verified
*without* a live Supabase connection is now done (schema translation, the
async DB layer, session store, Storage wrapper, the full route/utils
async/await conversion, Netlify deployment config, and the data/file
migration script - see "What's done so far" above). What's left all
genuinely requires either real Supabase connectivity or a human's own
judgment call, which is why it's stopped here rather than being guessed at:

1. Read this file, then skim the "What's done so far" and "What's NOT done
   yet" sections above to get oriented - the latter is the authoritative
   remaining-work list (3 items as of this writing).
2. Check whether your session's environment can reach `supabase.co` (try
   `curl -sS -o /dev/null -w '%{http_code}\n' https://supabase.co`) — every
   session that has worked on this so far (including this one) has been
   unable to, so this needs re-checking each time, not assumed. If yes, ask
   the user for the dev project's connection details again (they'll need to
   re-share them; nothing carries over) and do a **real** connection test
   before continuing, strictly better than this session's PGlite-only
   verification.
3. Also ask the user for `SUPABASE_SERVICE_ROLE_KEY` if it's needed for the
   next piece of work (Storage wiring, item 1 under "What's NOT done yet").
4. Do the 3 remaining items in order - each one genuinely depends on the
   one before it (Storage/session wiring, then a real run of
   `scripts/migrate-to-supabase.js`, then the final `db/index.js` deletion/
   promotion) - unlike the earlier route-by-route conversion work, which
   had no real ordering dependency between files.
5. Keep committing and pushing to `supabase-migration` after each real,
   tested chunk of progress — don't let uncommitted work pile up in one
   giant, harder-to-review change.
