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
  itself or any member of its own family (`utils/portalAuth.js`'s
  `familyForAccount`, generalized from Parent Portal's own student-only
  `childrenForAccount`) — every mutating route re-verifies the target
  member is really part of the acting account's family before writing
  anything.
- Real route-level tests: `test/routes-events.test.js` (admin create/
  publish, public-vs-members visibility, family registration + capacity/
  waitlist, cross-family access denial, volunteer slot-filling, donation
  claim clamping).

## Community & Commerce track — Business Directory, Classifieds (done —
   Track B, branch `platform-community-commerce`)

- `supabase/migrations/20260825040000_directory_classifieds.sql`:
  `business_directory_listings`, `classified_listings`. Both share the
  same submit → `pending` → admin-approved `active` → `archived` shape
  (classifieds adds a `sold` status the submitting member can set
  themselves); a new `manage_classifieds` permission was added to
  `db/bootstrapPg.js`'s `PORTAL_PERMISSIONS` catalog (`manage_directory`
  was already pre-seeded and covers the business directory).
- `utils/directory.js` / `utils/classifieds.js`: near-identical business
  logic, kept as two separate feature-scoped files (this codebase's own
  convention — one utils file per feature, not a generic "listings"
  engine) rather than one shared abstraction.
- `routes/admin-directory.js` (`/main-admin/directory`, `manage_directory`)
  / `routes/admin-classifieds.js` (`/main-admin/classifieds`,
  `manage_classifieds`): review queue, approve/archive/delete, edit any
  listing, image upload (same public-bucket pattern as Events' own image
  upload). Sibling routers, same reasoning as `routes/admin-events.js`.
- `routes/directory.js` (`/directory`) / `routes/classifieds.js`
  (`/classifieds`): public/member browsing (only `active` + visibility-
  appropriate listings show), a signed-in account's own `/mine` page to
  submit/edit/withdraw (or mark sold, classifieds) a listing for itself or
  any member of its own family — same `familyForAccount` scoping Events
  uses, now shared from `utils/portalAuth.js` rather than redefined per
  route file once a second feature needed the identical scope.
- Real route-level tests: `test/routes-directory-classifieds.test.js`
  (pending-hides-from-public → admin-approves → visible, public-vs-
  members visibility, cross-family submission denial, member withdrawal,
  classifieds sold-hides-from-active-browsing).

## Community & Commerce track — Member Directory (done — Track B, branch
   `platform-community-commerce`)

- `supabase/migrations/20260825050000_member_directory.sql`: no copy of
  member data — two small settings tables instead:
  `member_directory_field_settings` (which fields a Main Admin has opted
  INTO the directory — a fixed allowlist, `phone`/`email`/`address`/
  `grade_level`/`family`/`photo`, nothing on by default, never an
  arbitrary `members` column) and `member_directory_opt_outs` (which
  individual members have removed themselves entirely).
- `utils/memberDirectory.js`: reads live from `members`/`families`
  (Track A's own tables, read-only). `getFieldSettings()`/
  `setFieldVisibility()` for the admin allowlist,
  `isOptedOut()`/`setOptedOut()` for the per-member opt-out,
  `listDirectoryMembers()`/`getDirectoryMember()` for browsing (already
  excludes opted-out members).
- `routes/admin-member-directory.js` (`/main-admin/member-directory`,
  `manage_directory` — the same permission that already covers the
  business directory, per its own catalog description): one settings
  form, since there's no listing CRUD here — just which fields to expose.
- `routes/member-directory.js` (`/member-directory`): members-only for
  every route, no public option (unlike Events/Directory/Classifieds'
  own public toggle) — this is real personal contact information.
  Browsing/detail pages render only the fields the field settings turned
  on (`visibleFields()` trims a full member row down before it ever
  reaches a template), plus a `/mine` self-service page for a signed-in
  account to opt itself or any of its own family in or out.
- Real route-level tests: `test/routes-member-directory.test.js` (a field
  never leaks before it's turned on even though the data exists, turning
  a field on shows it everywhere, sign-in required, self opt-out takes
  effect immediately, cross-family opt-out denial).

## Community & Commerce track — Forums (done — Track B, branch
   `platform-community-commerce`)

- `supabase/migrations/20260825060000_forums.sql`: `forum_categories`
  (general or `scope='class'`, `class_id` referencing Track A's own
  `classes` table read-only), `forum_threads`, `forum_posts`, and
  `forum_moderation_actions` — the audit trail the handoff's own spec for
  this item explicitly calls for.
- `utils/sanitizeHtml.js` (new `sanitize-html` dependency): every post
  body is sanitized server-side against a small allowlist (headings/
  bold/italic/lists/links/quotes) before it's ever stored — the client-
  side rich-text toolbar (`public/js/forum-editor.js`, a `contenteditable`
  div + `execCommand`, "keep it simple, don't overbuild") only offers
  those same options, but the sanitizer is what actually enforces it, not
  client trust. A real XSS attempt (`<script>`/`onerror=`) is covered in
  `test/routes-forums.test.js`.
- `utils/forums.js`: category access (`canAccessCategory` — a `general`
  category is open to any signed-in account; a `class` category checks
  the acting account's whole family against `class_staff`/
  `class_enrollments`, so a student's own parent is covered without a
  special case, since `familyForAccount` already returns the whole
  family), thread/post CRUD, and every moderation action logging to
  `forum_moderation_actions`.
- `routes/forums.js` (`/forums`, members-only, no public option):
  browsing/posting, plus in-context moderation (edit-any/remove/restore/
  pin/lock/archive/move) gated per-action by
  `req.portalPermissions.has('manage_forum')` rather than a separate
  admin-only router — `manage_forum` can be granted to any role (e.g. a
  teacher moderating their own class forum), matching how Main Admin's
  own Roles & Permissions screen already treats permissions as
  independent of portal.
- `routes/admin-forums.js` (`/main-admin/forums`, `manage_forum`):
  category structural setup (create general or private class forums,
  lock/delete) and the moderation log viewer — day-to-day thread/post
  moderation deliberately lives in `routes/forums.js` instead, not here.
- 8 new views + `public/js/forum-editor.js` +
  `views/partials/forum-editor-toolbar.ejs`, and
  `test/routes-forums.test.js` (6 tests: sign-in required, thread
  creation + reply, server-side sanitization, private class forum access
  control, non-main_admin moderation + audit log entry, locked-thread
  reply denial).

## Community & Commerce track — Custom Forms (done — Track B, branch
   `platform-community-commerce`)

- `supabase/migrations/20260825070000_custom_forms.sql`: `custom_forms`,
  `custom_form_fields`, `custom_form_field_options` (a choice field's
  options are their own child table, same pattern the existing Training
  module already uses for quiz options — not a JSON blob column),
  `custom_form_assignments` ("specific people or groups" — a group is an
  existing portal role, reusing the RBAC model rather than a second
  grouping concept; zero assignment rows means the form is open to any
  signed-in account once published), `custom_form_submissions` (one per
  form+member, filled out on behalf of any member of the submitting
  account's own family), `custom_form_answers` +
  `custom_form_answer_choices` (the latter only for `multiple_choice`,
  since it can have more than one selected option).
- `utils/customForms.js`: one generic system for every field type
  (`short_text`/`long_text`/`number`/`date`/`single_choice`/
  `multiple_choice`/`dropdown`/`checkbox`/`file`) — per the handoff's own
  explicit instruction, no one-off form tables. `canAccessForm` mirrors
  Forums' own `canAccessCategory` shape (family + role-holding check).
- `routes/admin-custom-forms.js` (`/main-admin/forms`, `manage_forms`):
  field builder, assignments, submissions list/detail, and a CSV export
  reusing the existing `utils/spreadsheet.js` helper rather than a new
  one.
- `routes/custom-forms.js` (`/forms`, members-only): browsing/filling/
  viewing-own-submission, plus an authenticated file-answer download
  route. A real bug caught before it shipped: that download route
  (`/forms/files/:answerId`) has to be registered *before* the generic
  `/forms/:id` route or Express would match "files" itself as an `:id`
  first — route matching is definition order, not specificity. File
  uploads go to a private bucket whose local-disk fallback deliberately
  lives *outside* `public/` (unlike `admin-documents.js`'s own local
  fallback under `public/uploads/documents`, which is therefore directly
  fetchable by anyone who knows/guesses the key, since `express.static`
  serves all of `public/` unconditionally) — proxied exclusively through
  that authenticated route instead.
- 7 new views and `test/routes-custom-forms.test.js` (7 tests: sign-in
  required, an open form's simple field types all store correctly,
  multiple_choice multi-select + required-field validation, assigned-to-
  a-specific-member hides it from everyone else, assigned-to-a-role opens
  it to every holder, resubmission redirects instead of duplicating, and
  cross-family submission denial).

## Community & Commerce track — Accounting/Payments foundation (done —
   Track B, branch `platform-community-commerce`)

Built ahead of Store (handoff item 8) even though the handoff lists Store
first — item 9's own text requires Store's checkout to be wired through
this same abstraction rather than a separate "did they pay" flag, so the
real dependency runs the opposite direction from the numbering.

- `supabase/migrations/20260825080000_payments_foundation.sql`:
  `payment_charges` (money owed — a store order, an event registration
  fee, or a manual charge; `status` is never set directly by a route,
  only ever recomputed from real payment rows), `payment_payments` (one
  row per real payment or refund — positive/negative `amount_cents` —
  against a charge). A payment **abstraction** only: no real processor is
  integrated, no raw card data is ever stored: `method` is `'manual'`
  today (an admin recording something that already happened outside the
  app — cash, check, Venmo) with a `'stripe_placeholder'` value reserved
  for later.
- `utils/payments.js`: `recalculateStatus()` is the one place a charge's
  status changes, always derived from its own `payment_payments` rows.
  A full refund closes a charge out (`'refunded'`) rather than re-billing
  the member for the same amount — caught and fixed via a failing test
  before it shipped, so `balanceForMember()` only ever sums `'pending'`
  charges, not refunded/partially-refunded ones. `formatCents()` is the
  one place this app formats a dollar amount, reused by every view here.
- `routes/admin-accounting.js` (`/main-admin/accounting`,
  `manage_finances` — already pre-seeded): per-member charge/payment/
  refund recording, a member picker to reach anyone with no charge
  history yet.
- `routes/accounting.js` (`/accounting`): would naturally live as a tab
  inside the Parent Portal, but `routes/parent-portal.js`/
  `views/parent-*.ejs` are off-limits — a sibling top-level page instead
  (same reasoning as Member Directory/Forums/Custom Forms), open to any
  signed-in account's own family, any role, showing balance/charges/
  receipt history.
- 3 new views and `test/routes-accounting.test.js` (5 tests: sign-in
  required, a charge goes pending → paid and the member sees it in their
  own Accounting page, a full refund closes the charge without re-billing
  the balance, a cancelled charge stays cancelled even if a stray payment
  is recorded against it, cross-family charge visibility denial).

## Community & Commerce track — Store (done — Track B, branch
   `platform-community-commerce`)

- `supabase/migrations/20260825090000_store.sql`: `store_products`
  (`inventory_count` null = unlimited, decremented live on every order,
  restored on cancellation — never trusted from a client),
  `store_orders` (`sale_type` — `'online'` or `'in_person'` — is the
  "must be recorded distinctly, not faked as a real online transaction"
  requirement made structural: an in-person sale is created through its
  own dedicated admin action and is `'paid'` immediately in that same
  action, while an online order always starts `'pending'` until a Main
  Admin records the payment through Accounting), `store_order_items`
  (`unit_price_cents` is a price snapshot — a later price change never
  retroactively changes what a past order shows as charged).
- `utils/store.js`: `placeOnlineOrder()`/`recordInPersonSale()` share
  `buildOrderLines()`, which re-validates every item against live
  product rows (availability, active status, real inventory) and never
  trusts a client-sent price or quantity. Every order's charge routes
  through `utils/payments.js`, item 9's own abstraction — no separate
  "did they pay" flag.
- `routes/admin-store.js` (`/main-admin/store`, `manage_store` — already
  pre-seeded): product CRUD + image upload (same public-bucket pattern
  as Events), the in-person-sale form, fulfillment/cancellation.
- `routes/store.js` (`/store`, members-only, no public storefront):
  browsing, checkout for self or family, order history. Checkout never
  collects payment — the confirmation page points to Accounting, where
  the balance shows up as a real, admin-recorded charge.
- 7 new views and `test/routes-store.test.js` (6 tests: sign-in required,
  an online order starts pending and creates a real Accounting charge, an
  in-person sale is paid immediately and distinct from an online order,
  inventory is checked live and rejects an over-quantity order,
  cancelling an order restores inventory and cancels its charge instead
  of leaving it owed, cross-family purchase/order-viewing denial).

## Explicitly NOT built yet

Student Portal, Teacher Portal, lessons/assignments/grading beyond the
existing Training module, staged/group registration windows (today it's a
simple per-class open/closed toggle) — all Track A scope. Weekly
newsletter, SMS/notification framework, Photos/Albums + Publications/
Articles, audit log, and global search — Track B scope, next up after
Events/Volunteer/Donation signups, Business Directory/Classifieds, Member
Directory, Forums, Custom Forms, Accounting/Payments, and Store above.
Also still missing: Diplomas, Transcripts, Library parent-facing integration,
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
