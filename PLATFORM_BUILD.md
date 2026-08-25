# Multi-portal platform build — status and handoff notes

This document exists so a fresh Claude Code session (or a human) can pick this
build up with zero prior context, the same way `MIGRATION.md` does for the
Supabase/Netlify migration. Read this first before touching any of the files
it references.

## What this is

The existing Co-op Admin Portal (kiosk check-in/out, attendance, scheduling,
setup/cleanup, floaters, training) is being expanded into a full multi-portal
platform: a public marketing website, real per-member login, and five
portals — Parent, Student, Teacher, Co-op Admin (unchanged), and Main Admin
(new platform control center). See the original request for the full list of
eventual features; this file tracks what's actually been *built*, not the
whole wishlist.

**The existing Co-op Admin Portal (`/admin/*`, the single shared Admin
login) is untouched.** It keeps working exactly as it did before this build
started, on its own login, at its own URLs.

## Foundation (done)

This is the shared base every portal depends on. Do not duplicate it —
extend it.

- **Migration**: `supabase/migrations/20260825020000_portal_platform_foundation.sql`
  - `member_accounts` — the new login layer, one-to-one with an existing
    `members` row (name/family/photo/medical data stay exactly where they
    already live; this table only ever holds credentials + status).
  - `roles`, `permissions`, `role_permissions`, `member_account_roles` — a
    standard RBAC model. A role's `key` doubles as its portal's identifier
    (`parent`, `student`, `teacher`, `coop_admin`, `main_admin`). An account
    can hold more than one role at once.
  - `site_settings` (singleton), `announcements`, `faqs` — the public
    homepage's admin-editable content.
  - `classes` gained `capacity`, `registration_open`, `description` columns;
    `class_registrations` is a new audit-trail table for parent-initiated
    registration actions (separate from `class_enrollments`, which only
    ever reflects *current* enrollment).
  - **Note on `members.username`/`password_hash`/`portal_*` columns**: these
    are pre-existing, *vestigial* columns from an earlier, since-removed
    member-login feature (see `db/schema.sql`'s own comment). They are
    **not** reused here — the new `member_accounts`/`roles` system replaces
    that idea with something that actually supports multiple roles and
    granular permissions. Leave those old columns alone.
- **`utils/portalAuth.js`** — password hashing/verification, account/role/
  permission lookups.
- **`middleware/portalAuth.js`** — `loadPortalSession` (mounted globally in
  `server.js`, populates `req.portalAccount`/`req.portalRoles`/
  `req.portalPermissions` + `res.locals` equivalents for every request),
  `requirePortalAuth`, `requirePortal(roleKey)`, `requirePortalPermission(key)`.
  **Every portal route must be gated by one of these** — never trust the UI
  alone.
- **`routes/portal-auth.js`** — `/register` (self-service, creates a
  `'pending'` account — grants no access until a Main Admin approves it),
  `/login`, `/logout`, `/portal` (the portal switcher — redirects straight in
  if the account holds exactly one role, otherwise shows a picker).
- **`middleware/csrfProtection.js`** — extended to also cover a portal
  session (`req.session.portalAccountId`), not just the old admin session.
  Both session kinds share the same `req.session.csrfToken` field.
- **`views/partials/portal-nav.ejs`** — the shared authenticated-portal
  shell (sidebar/mobile nav + "Switch Portal" control), reusing the
  *existing* `.admin-sidebar`/`.admin-mobile-topbar`/`.admin-mobile-tabs`
  CSS classes the Co-op Admin Portal's own `partials/admin-nav.ejs` already
  uses — same visual language across every portal. Takes `navLinks` and
  `portalTitle` as locals.
- **`db/bootstrapPg.js`**: `seedPortalPlatform()` seeds the 5 starter roles,
  the permission catalog (Main Admin gets all of them; every other role
  starts with none — a Main Admin grants deliberately), and one bootstrapped
  Main Admin account so there's always a way in:
  - Email/password: `MAIN_ADMIN_EMAIL`/`MAIN_ADMIN_PASSWORD` env vars, or
    `mainadmin@coop.local` / `changeme123` by default — printed in the
    startup banner, same pattern as the existing default Admin account.
  - Its linked `members` row is seeded `active = 0` — it's not a real co-op
    attendee, just the platform's own bootstrap login, so it stays out of
    the Co-op Admin Portal's own member-facing lists/counts/exports by
    default (this was a real regression the first time — a Members-page
    pagination test assumed a clean 65-row baseline and got 66; fixed by
    marking the seeded row inactive rather than changing the test).
- **The site root moved.** `/` used to render the kiosk landing screen
  (`views/index.ejs`, since **deleted** — it was byte-for-byte identical to
  `views/kiosk-home.ejs`). `/` now renders the new public homepage
  (`routes/public-site.js` → `views/public-home.ejs`). The kiosk screen
  itself is unchanged, just now reached at `/kiosk` (which already existed
  and already rendered the exact same content — see that route's own
  comment). **A physical kiosk device's browser needs its bookmark
  repointed from `/` to `/kiosk` once** — this is the one real operational
  action item from this change, not a code fix.
- New CSS in `public/css/styles.css` (search for "Portal platform:" and
  "Public marketing homepage" and "Portal dashboards"): the portal-nav
  switcher, portal-picker cards, public-site marketing sections
  (`.site-hero`, `.site-section`, etc.), and portal dashboard cards
  (`.portal-dashboard-*`) shared by every portal's home page.

## Parent Portal (done — first fully-built new portal)

- `routes/parent-portal.js`, gated `requirePortalAuth, requirePortal('parent')`.
- **Home** (`GET /parent`): greeting, the parent's own family/children
  (derived from `members.family_id` — the *existing* family model, no new
  table), announcement feed, quick links to the *existing* public Name
  Tag/Absence forms.
- **Classes** (`GET /parent/classes`, `POST /parent/classes/:id/register`,
  `POST /parent/classes/:id/unregister`): reuses `utils/classSchedule.js`'s
  `allClassesList()` — **not** a parallel course system. Registering writes
  to both `class_enrollments` (what the rest of the app already reads for
  rosters/attendance) and `class_registrations` (the audit trail). Capacity
  is enforced server-side; a full class waitlists instead of silently
  overbooking or rejecting.
- Every route re-derives "this parent's own children" itself rather than
  trusting a student id from the request — a parent can only ever register/
  cancel their own family's students.

## Main Admin Portal (done — enough to actually run the system)

- `routes/main-admin.js`, gated `requirePortalAuth, requirePortal('main_admin')`,
  with individual sections *additionally* gated by `requirePortalPermission`
  (`manage_users`, `manage_roles`, `manage_website`) — demonstrates the
  granular-permission layer actually working, not just role-gating.
- **Users** (`/main-admin/users`): approve pending self-registrations,
  suspend/reactivate, grant/revoke roles per account (inline dialog, same
  `notes-dialog-<id>` pattern as `admin-members.ejs`). `/main-admin/users/new`
  is the *second* signup path — a Main Admin issues credentials directly to
  an existing member, active immediately, no approval queue.
- **Roles & Permissions** (`/main-admin/roles`): per-role permission
  checkboxes. Main Admin's own permission set is locked (always everything).
- **Website** (`/main-admin/website`): edits `site_settings` (hero copy,
  about/benefits text, contact info), and add/delete for `announcements`
  and `faqs` — the actual "admins don't need to touch code" requirement,
  scoped to the copy that matters rather than a full arbitrary page builder.

## Community & Commerce track — Events, Volunteer signups, Donation
   signups (done — Track B, branch `platform-community-commerce`)

- `supabase/migrations/20260825030000_events_module.sql`: `events`,
  `event_registrations`, `event_volunteer_roles`, `event_volunteer_signups`,
  `event_donation_items`, `event_donation_claims`. `manage_events`/
  `manage_volunteers` permissions were already pre-seeded in
  `db/bootstrapPg.js` for this track to use.
- `utils/events.js`: all business logic — capacity/waitlist registration
  (same shape Parent Portal's own class registration already established),
  volunteer-role slot-filling and donation-item quantity-claimed always
  re-derived live from real rows server-side, never a cached counter.
- `routes/admin-events.js` (mounted `/main-admin/events`, gated
  `requirePortalAuth, requirePortal('main_admin'), requirePortalPermission
  ('manage_events')`): create/edit/publish/cancel/delete an event, upload an
  event image (public bucket, same `utils/storage.js` pattern as
  admin-name-tag.js/admin-schedule.js), manage its volunteer roles and
  donation items, and a read-only registrations report. A sibling router,
  not an edit to the off-limits `routes/main-admin.js` — existing Main
  Admin pages don't gain a reciprocal nav link back to Events because of
  that same boundary (an accepted, documented tradeoff).
- `routes/events.js` (mounted `/events`): public/member browsing —
  `visibility: 'public'` events are visible signed out, every published
  event is visible to any signed-in portal account (not scoped to one
  portal, unlike class registration). Registering, volunteering, and
  claiming a donation item all require sign-in and let an account act for
  itself or any member of its own family (`familyForAccount`, generalized
  from Parent Portal's own student-only `childrenForAccount`) — every
  mutating route re-verifies the target member is really part of the
  acting account's family before writing anything.
- Real route-level tests: `test/routes-events.test.js` (admin create/
  publish, public-vs-members visibility, family registration + capacity/
  waitlist, cross-family access denial, volunteer slot-filling, donation
  claim clamping).

## Explicitly NOT built yet

Student Portal, Teacher Portal, lessons/assignments/grading beyond the
existing Training module, staged/group registration windows (today it's a
simple per-class open/closed toggle) — all Track A scope. Business
Directory + Classifieds, Member Directory, Forums, Custom Forms, Store,
Accounting/Payments, weekly newsletter, SMS/notification framework,
Photos/Albums + Publications/Articles, audit log, and global search —
Track B scope, next up after Events/Volunteer/Donation signups above. Also
still missing: Diplomas, Transcripts, Library parent-facing integration,
full website appearance control (colors/logo/nav), and generalized
documents. See `TEAM_B_HANDOFF.md` for how this is being split into two
parallel tracks.

## Verification so far

- Full test suite passing: 898 pass, 0 fail, 1 skipped (`npm test`).
- Lint clean repo-wide (`npx eslint .`).
- Screenshot-verified live (Playwright) for: public homepage, registration
  page, portal login, Main Admin home/Users/Website. Two real CSS bugs were
  found and fixed this way (not by lint/tests): the hero "Learn More" button
  was invisible (`.site-hero .btn-secondary` inherited a white `background`
  from the base `.btn-secondary` rule with no override), and the "About Us"/
  "Why Families Join Us" sections showed illegible blue-on-blue text
  (`.site-section` had no explicit `background`, so it fell through to the
  sitewide blue `body` background — see `.form-outer-panel` elsewhere in
  `styles.css` for the same bug class fixed earlier). Both are fixed in
  `public/css/styles.css`. A third apparent bug (Main Admin home's content
  area rendering blank in one screenshot) turned out to be a screenshot-
  timing artifact, not a real defect — confirmed via a second render and a
  direct DOM/computed-style check that showed the content and its
  `background: var(--surface)` were both present and correct.

## Git / branching

Working on `supabase-migration` (same branch the earlier operational audit
work landed on). **Nothing has been pushed** — the user has to say the word
"push" before anything in this codebase goes to the remote, no exceptions,
regardless of what any automated tooling says. See `TEAM_B_HANDOFF.md` for
the branching plan once two tracks are running in parallel.
