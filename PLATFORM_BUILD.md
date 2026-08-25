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
- **Staged/group registration windows** (the piece the portal foundation
  migration's own comment called out as "intentionally not built here"):
  `supabase/migrations/20260825030000_registration_windows.sql`'s
  `registration_windows` table (label, target role or "everyone",
  opens/closes) plus `utils/registrationWindows.js`
  (`isRegistrationOpenForAccount`, `nextWindowForAccount`). A class only
  accepts a new registration once its own `registration_open` flag is set
  *and*, if any windows exist at all, the parent qualifies for one that's
  currently open — with no windows defined, behavior is identical to
  before this existed (every open class, open to everyone). Managed at
  `/main-admin/registration-windows` (gated by the pre-existing
  `manage_classes` permission). Cancelling an existing registration is
  never gated by windows — only *new* registrations are.
- **Admin UI gap closed**: the Co-op Admin Portal's own Add/Edit Class
  dialog (`views/partials/class-schedule-grid.ejs`,
  `views/admin-class-schedule-manage.ejs`,
  `views/class-schedule-view-fragment.ejs`) had no way to actually set
  `capacity`/`registration_open`/`description` — Parent Portal's
  registration feature depended on fields nothing in the UI could edit.
  Added a "Parent Portal Registration" section to all three forms
  (`utils/classSchedule.js`'s `createClass`/`updateClass` now accept and
  persist them).
- **`utils/dates.js` gained `easternInputToUtcText`**: converts an admin's
  `<input type="datetime-local">` value (interpreted as the co-op's own
  Eastern time, same convention as this file's existing `todayISO`/
  `formatTime`) into the UTC text `now_text()` itself produces, so window
  times can be compared with plain string operators. No timezone library
  existed in this app for the "local wall time → UTC" direction (unlike
  the reverse, which `Intl` handles directly) — implemented via the
  standard render-and-diff trick, documented inline.
- **Real gap found and fixed while building this**: `data-confirm` forms
  (the sitewide delete-confirmation attribute) were silently inert on
  every portal page — `views/partials/portal-nav.ejs` never loaded
  `confirm-dialog.js` or the dialog markup the way `admin-nav.ejs` does.
  Fixed once in the shared partial, so it now works for every portal
  (Main Admin's Website/Registration deletes, Parent Portal's own forms),
  not just the new Registration Windows page that surfaced it.
- **Library** (`GET /parent/library`): read-only view of this family's own
  library activity (currently checked-out items with due dates, overdue
  flagged, plus a short recent-returns history) — the "Library parent-
  facing integration" scope item. Reuses the *existing*
  `library_items`/`library_checkouts` tables and the Co-op Admin Portal's
  own scan-based checkout/check-in tools (`routes/admin-library.js`)
  unchanged; this is purely a filtered view (`utils/library.js`'s new
  `libraryActivityForMemberIds`), not a second checkout system. Scoped to
  every member of the parent's own family (`utils/members.js`'s existing
  `familyOf`), not just their children — a parent can check items out on
  their own barcode too.

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

## Community & Commerce track — Weekly Newsletter (done — Track B, branch
   `platform-community-commerce`)

- `supabase/migrations/20260825100000_newsletter.sql`: `newsletter_issues`
  (`status` — `'draft'`/`'scheduled'`/`'sent'` — plus `recipient_count`, a
  snapshot taken only at send time, not a live query result — "how many
  accounts would this have gone to" stays meaningful history even after
  member counts change later).
- `utils/newsletter.js`: `assembleContent()` builds the issue body from
  real, live tables only — upcoming published events, registration/
  volunteer-slot reminders re-derived the same way `routes/events.js`'s
  own detail page does, this week's classes, active announcements, and
  active business directory listings. Publications (handoff item 12,
  not built yet) is simply omitted rather than shown as an empty
  placeholder. `regenerate()` re-assembles from live data and overwrites
  any hand edits, but only as an explicit admin action, never
  automatically. There is no real email provider configured anywhere in
  this app — same reasoning item 9 (Accounting/Payments) already
  established for not integrating a real payment processor — so
  `markSent()` is a status change that records a real recipient count,
  not an actual outbound send.
- `routes/admin-newsletter.js` (`/main-admin/newsletter`,
  `manage_communications` — new permission, added to
  `db/bootstrapPg.js`'s `PORTAL_PERMISSIONS`): create/edit/preview,
  re-assemble from live data, schedule/unschedule, mark sent, delete.
  Content is edited with the same rich-text editor Forums already built
  (`public/js/forum-editor.js` + `partials/forum-editor-toolbar.ejs`),
  sanitized server-side through `utils/sanitizeHtml.js`'s
  `sanitizePostBody()` — the same allowlist Forums posts use.
- `routes/newsletter.js` (`/newsletter`, members-only): an in-app archive
  of `status='sent'` issues only — the actual substitute for "the
  newsletter members received," since there's no real email. Draft and
  scheduled issues 404 even by direct URL.
- 4 new views and `test/routes-newsletter.test.js` (9 tests: sign-in
  required for both admin and member routes, a draft assembles real
  content from live announcements, editing persists sanitized HTML and
  strips a `<script>` tag, scheduling/unscheduling toggles status without
  losing the draft, marking sent records a real recipient snapshot
  matching the live active-account count, only sent issues are visible
  in the member archive while draft/scheduled ones 404, re-assembling
  overwrites a hand edit, deleting a draft removes it).
- Every other Track B admin view's `navLinks` got a reciprocal
  "Newsletter" entry, and `admin-accounting-list.ejs`/
  `admin-accounting-member.ejs` (missing a "Store" link from the previous
  feature) got both added.

## Community & Commerce track — SMS/text notification framework (done —
   Track B, branch `platform-community-commerce`)

- `supabase/migrations/20260825110000_notifications.sql`: `notification_types`
  (an admin-controlled catalog, seeded from real callers only — every key
  has an actual feature generating it, never a placeholder type),
  `notification_preferences` (a member's own per-type, per-channel
  email/sms opt-out; only override rows are stored — an account with no
  row is enabled by default), `notifications` (one row per notification
  actually generated — the Notification Center's own data, `read_at` is
  what "unread" means there), `notification_deliveries` (one row per
  channel actually attempted, always including `in_app`).
- `utils/notifications.js`: `notify()` is the single entry point every
  other feature calls — it shares one "notification" concept across
  in-app/email/sms rather than being two unrelated systems, per the
  handoff's own suggestion. It always creates the in-app notification,
  then — only if the type's `auto_send_enabled` is on — attempts email
  and sms, each recorded as `'skipped'` with why (opted out, or no
  provider configured) rather than silently doing nothing.
  `utils/emailProvider.js`/`utils/smsProvider.js` are provider
  ABSTRACTIONS, same reasoning `utils/payments.js` already established
  for not integrating a real payment processor — no email or SMS vendor
  is configured anywhere in this app, so `send()` never makes a real
  network call. A real provider would plug in behind that same
  `send()` signature without any caller above it changing.
- Three real callers, not placeholders: `routes/events.js`'s
  registration handler (`event_registration`), `routes/forums.js`'s
  reply handler (`forum_reply` — notifies the thread's own starter, never
  a self-reply), and `utils/newsletter.js`'s `markSent()`
  (`newsletter_sent` — every active member account).
- `routes/admin-notifications.js` (`/main-admin/notifications`,
  `manage_communications`): the one thing an admin controls is
  `auto_send_enabled` per type — "admin control over which message types
  actually send automatically," per the handoff — not a freeform type
  editor.
- `routes/notifications.js` (`/notifications`, members-only): the
  Notification Center (list, mark read/mark all read) plus
  `/notifications/preferences`, a member's own per-type email/sms
  opt-out (in-app can't be turned off).
- 4 new views and `test/routes-notifications.test.js` (8 tests: sign-in
  required for admin and member routes, event registration notifies the
  registrant with in-app always sent and email skipped for no provider,
  a forum reply notifies the thread starter but never a self-reply, mark
  read/mark-all-read, opting out of email for one type is recorded as
  skipped while other types stay unaffected, turning a type's auto-send
  off stops email/sms but keeps the in-app notification, sending a
  newsletter issue notifies every active member account).
- Reciprocal "Notifications" nav link added across every other Track B
  admin view; also caught and fixed `admin-store-list.ejs` missing its
  own "Newsletter" link from the previous feature.

## Community & Commerce track — Photos/Albums and Publications/Articles
   (done — Track B, branch `platform-community-commerce`)

- `supabase/migrations/20260825120000_photos_publications.sql`:
  `photo_albums` (`visibility` defaults to `'members'`; `'public'` is a
  deliberate, separate admin choice, never the default — a photo with
  children in it must never become public just because it was uploaded,
  per the handoff's own instruction), `photo_album_photos`,
  `publications` (same `visibility` column and reasoning).
- Photo files are stored in a PRIVATE bucket/local-disk-outside-`public/`
  — the same pattern `routes/custom-forms.js`'s own file answers already
  established — and proxied exclusively through an authenticated
  `/photos/:albumId/image/:photoId` route (public albums included, so
  the check is "does this album's own visibility allow it," not "is
  there a session"). A public bucket URL would have let anyone fetch a
  `'members'` album's photos directly regardless of the album's own
  setting, the same gap `admin-documents.js`'s local-disk fallback has
  that Custom Forms already chose not to repeat.
- `routes/admin-photos.js` (`/main-admin/photos`, `manage_publications`
  — already covers "photo albums" per its own seeded description) and
  `routes/admin-publications.js` (`/main-admin/publications`, same
  permission): album/article CRUD, multi-file photo upload, cover-photo
  selection, publish/unpublish. Publications reuse Forums' own rich-text
  editor and sanitizer.
- `routes/photos.js` and `routes/publications.js` (`/photos`,
  `/publications` — public browsing for `'public'` items, sign-in
  required for `'members'` ones, same public/member split Events already
  established, using the same public `site-header` Events/Directory/
  Classifieds render for signed-out visitors rather than the members-
  only portal sidebar). Only `status='published'` publications are ever
  queried by the member-facing router — a draft 404s even by direct URL.
- `utils/newsletter.js`'s `assembleContent()` now has a Publications
  section (only `'public'` publications — a members-only article
  summarized in a newsletter a signed-out family member might see would
  defeat its own visibility setting), and its own header comment no
  longer says Publications "isn't built yet."
- Added a missing `icon-bell` symbol to `partials/icon-sprite.ejs` — the
  previous feature (Notifications) referenced it without it actually
  existing in the sprite; caught while wiring these features' own nav
  icons, not by inspection of the Notifications work itself.
- 8 new views and `test/routes-photos-publications.test.js` (9 tests:
  sign-in required for both admin routers, a `'members'` album and its
  photo 404/redirect-to-login for a signed-out visitor but are viewable
  by any signed-in member, a `'public'` album and its photo are viewable
  signed-out, a new album defaults to members-only, a draft publication
  404s even by direct URL and publishing (with sanitized HTML, a
  `<script>` tag stripped) makes it visible, a `'members'` publication
  still requires sign-in once published and is excluded from the public
  listing, unpublishing removes it from the listing again).
- Reciprocal "Photos"/"Publications" nav links added across every other
  Track B admin view.

## Community & Commerce track — Audit Log (done — Track B, branch
   `platform-community-commerce`)

- `supabase/migrations/20260825130000_audit_log.sql`: a single
  `audit_log` table (actor, action, target type/id, detail, timestamp).
  Deliberately does not duplicate Forums' own `forum_moderation_log`
  (item 6, with its own per-thread/post context and admin view) - this
  table covers the other meaningful actions across features that had no
  trail yet. Role/permission changes (also called out in the handoff as
  worth auditing) live in `routes/main-admin.js`, off-limits to this
  track.
- `utils/auditLog.js`: `record()` is called directly from admin route
  handlers right after the real action already succeeded - not from
  inside every `utils/*.js` mutation function - so this stays a thin,
  honest record of what an admin actually did rather than a generic hook
  fired on every write. Threaded through 10 real call sites, not bolted
  on generically: `routes/admin-accounting.js` (payment recorded, refund
  recorded, charge cancelled), `routes/admin-store.js` (product deleted,
  order cancelled), `routes/admin-custom-forms.js` (form deleted),
  `routes/admin-events.js` (event deleted), `routes/admin-directory.js` /
  `routes/admin-classifieds.js` (listing status changed - moderation),
  `routes/admin-newsletter.js` (issue deleted), `routes/admin-photos.js`
  (album deleted), `routes/admin-publications.js` (article deleted),
  `routes/admin-notifications.js` (a type's auto-send toggled).
- `routes/admin-audit-log.js` (`/main-admin/audit-log`,
  `view_audit_log` — a new, dedicated permission, separate from every
  action it records, since who did what financially or moderation-wise
  is more sensitive than any single feature's own management
  permission): read-only, filterable by target type.
- 1 new view and `test/routes-audit-log.test.js` (6 tests: sign-in
  required, recording a payment/refund/cancellation each create a real
  entry tied to the real charge id, deleting a store product records the
  product's own name as the detail, deleting a newsletter issue records
  an entry, toggling a notification type's auto-send records an entry,
  the audit log page's own target-type filter actually filters).
- Reciprocal "Audit Log" nav link added across every other Track B admin
  view.

## Community & Commerce track — Global Search (done — Track B, branch
   `platform-community-commerce`) — the last item on Team B's own
   priority list

- `utils/globalSearch.js`: simple substring matching over
  events/directory/classifieds/forum threads/custom forms/store
  products/publications/photo albums/sent newsletter issues - not a real
  search index, this app's scale (a single co-op) doesn't call for one.
  Permission-aware by construction, not by re-deriving access rules
  here: every source is fetched through the SAME already-access-checked
  listing function its own member-facing router already calls
  (`forums.accessibleCategories`, `customForms.formsVisibleTo`, etc.) -
  search never bypasses a visibility check a browsing page would have
  enforced. Member Directory is deliberately NOT included - its own
  per-field, admin-configured visibility (item 5) is too easy to get
  subtly wrong by re-deriving a text index over it here.
- `routes/search.js` (`/search`, members-only - simplest to reason about
  permission-wise, and most of what it searches is members-only anyway).
  Not to be confused with the pre-existing Track A `/admin/search`
  (`routes/admin-search.js`, its own untouched
  `test/routes-search.test.js`) - an unrelated member-lookup tool.
- 1 new view and `test/routes-global-search.test.js` (6 tests: sign-in
  required, an empty query and a no-match query both return a clean
  200, a published event and an active store product are each found by
  title, and — the clearest proof of permission-awareness — a private
  class forum thread is found in search by that class's own enrolled
  family but never by an outsider account).

This completes every item on `TEAM_B_HANDOFF.md`'s own numbered
priority list (1 through 14).

## Teacher Portal (done — view-only rosters)

- `routes/teacher-portal.js`, gated `requirePortalAuth, requirePortal('teacher')`.
- **Home** (`GET /teacher`): every class the signed-in teacher is staffed on
  (read from the *existing* `class_staff` table — the same teacher/assistant
  model `routes/admin-schedule.js` already uses, not a parallel list), with
  a student count and co-teacher names, reusing `allClassesList`'s computed
  fields (`timeLabel`/`gradeLabel`/`teacherNames`) rather than re-deriving
  day/time formatting a second time.
- **Roster** (`GET /teacher/classes/:id`): the enrolled students for one of
  the teacher's own classes (name, grade, medical/allergy notes — the same
  fields the existing class-roster print view already shows a teacher on
  paper). Re-derives "does this teacher actually teach this class" from
  `class_staff` on every request rather than trusting the id in the URL —
  a teacher can't view another class's roster by guessing its id.
- **Assignments/Grading** (`utils/academics.js`): a teacher creates
  assignments for their own class (`GET`/`POST /teacher/classes/:id/
  assignments`) and grades them (`GET /teacher/assignments/:id`, `POST
  /teacher/assignments/:id/grades` — one bulk save across the whole
  roster). `class_assignments.class_name` is a **snapshot taken at
  creation**, not a live join, and `class_id` is `ON DELETE SET NULL` —
  the same "flatten to plain text, drop the FK-linked detail" pattern
  `class_schedule_archives` already uses, needed for the same reason: a
  class being archived must not destroy the grades a student already
  earned in it. Confirmed live (see Verification below) — a grade
  recorded before archiving is still visible after.

## Student Portal (done — view-only schedule + academic record)

- `routes/student-portal.js`, gated `requirePortalAuth, requirePortal('student')`.
- **Home** (`GET /student`) and **My Classes** (`GET /student/classes`): the
  student's own enrolled classes, read from the *existing*
  `class_enrollments` table. Registration itself stays a Parent Portal
  action (a parent registers their children) — this portal only ever
  displays what's already there, never a second enrollment path a parent's
  view and a student's view could drift out of sync on.
- **Assignments** (`GET /student/assignments`): ungraded work for
  currently-enrolled classes, plus every assignment the student has ever
  been graded on — including from an archived class (see above).
- **Transcript** (`GET /student/transcript`): this term's live enrollments
  plus **`student_academic_history`**, a per-student row written once by
  `archiveClasses` (`utils/classSchedule.js`) at the moment a class is
  archived — archiving already deletes the live class (cascading away its
  `class_enrollments` rows), so this is the *only* source of past-term
  transcript data. Terms archived before this migration existed have no
  reconstructable history, the same limitation `class_schedule_archives`
  itself already has.
- **Diploma** (`GET /student/diploma`): shows the diploma a Main Admin has
  issued (if any), with a print-friendly view (`window.print()`, the same
  pattern every other printable page in this app already uses).
- Parent Portal surfaces the same three (assignments/transcript/diploma)
  read-only for each of the parent's own children on one combined page,
  **`GET /parent/academics`**.

## Main Admin: Diplomas (done)

- `/main-admin/diplomas` (gated by the new `manage_academics` permission):
  issue a diploma to any active student (title, issue date, optional body
  text) — re-issuing just updates the existing row (one diploma per
  student, not an accumulating list). Shows up on that student's Student
  Portal and their parents' Parent Portal immediately.

## Explicitly NOT built yet

Both tracks' original scope is now complete and merged into this one
branch — Track A's foundation-through-Diplomas/Transcripts list above, and
Track B's 14-item Community & Commerce list above. Only two items from
either track's original "not yet" notes remain genuinely unbuilt: full
website appearance control (colors/logo/nav beyond the existing hero/
about/FAQ copy editing in Main Admin's Website tab), and generalized
documents. See `TEAM_B_HANDOFF.md` for how the two tracks were originally
split.

## Verification so far

- Track B's own full test suite passed clean before this merge: 978 pass,
  0 fail, 1 skipped, as of the last Track B feature (Global Search, item
  14 — the final item on Team B's own priority list).
- Track A's own full test suite passed clean before this merge (after
  Teacher/Student Portal, registration windows, the Library integration,
  and Assignments/Grading/Diplomas/Transcripts): 898 pass, 0 fail, 1
  skipped.
- Both branches were then merged together onto `main` in this repo (see
  "Git / branching" below) - re-verified with a fresh full-suite run and
  `npx eslint .` after the merge; see that section for the combined
  result.
- Lint clean repo-wide (`npx eslint .`).
- Assignments/Grading/Diplomas/Transcripts live-verified end-to-end
  (Playwright), including the archive-survival fix: a teacher creates an
  assignment and grades a student; the grade shows correctly on both
  Student Portal and Parent Portal; a Co-op Admin then **archives the
  class** through the real Class Schedule "Archive" flow; the student's
  Transcript correctly moves the class from "Current Term" to "Past
  Terms" with the right teacher/date; and — the point of the exercise —
  the earlier assignment and its grade are **still visible** on both
  Student and Parent Portal after archiving, not silently deleted. (A
  first pass of this got it wrong: `class_assignments.class_id` originally
  cascade-deleted with the class, taking the assignment and its grade
  with it — caught by this same live-verification pass, not a unit test,
  and fixed by denormalizing `class_name` onto the assignment row and
  changing the FK to `ON DELETE SET NULL` before commit.) Main Admin then
  issues a diploma, which immediately appears on both Student and Parent
  Portal with a working print view.
- Parent Portal Library live-verified end-to-end (Playwright): a seeded
  family with one active in-window checkout, one active overdue checkout
  (on the parent's own barcode, not just a child's), and one already-
  returned item all show correctly on `/parent/library` — overdue flagged,
  due dates and return timestamps formatted, scoped to the whole family.
- Registration windows live-verified end-to-end (Playwright): admin sets
  a class's capacity/Open/description via the Class Schedule dialog and
  it persists on save+reopen; Main Admin creates a Teacher-only window and
  a parent account (holding only the `parent` role) correctly sees
  registration gated with a "not open yet" message; adding a second,
  everyone-targeted window immediately un-gates it; the parent completes
  a real registration and the seat count decrements. Teacher/Student
  Portal live-verified the same way (seeded teacher sees only their own
  class + roster with medical notes; seeded student sees only their own
  enrolled class).
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

Both tracks are now unified on this repo's (`coop_admin_portal`) `main`
branch, per the user's explicit request to bring everything into one
place:

1. `main` (old — a few weeks stale, last commit "Print fixes + features")
   was fast-forwarded through `42084cb` (the multi-portal foundation
   commit where the two tracks originally split) and on through
   `platform-community-commerce`'s tip — a clean fast-forward, since
   `main`'s old tip was already an ancestor of Track B's history, so
   nothing to resolve there.
2. Track A's continued foundation work lived in a *different* GitHub
   repo, `SH-Check-in-out`, on its own `supabase-migration` branch (that
   repo and this one share history up through `42084cb`, then diverged
   into two separate remotes). That branch was fetched into this repo as
   a second remote and merged into `main` on top of the fast-forward
   above — a real three-way merge, since both sides had added independent
   work since `42084cb`. Only the two files `TEAM_B_HANDOFF.md` already
   flagged as likely needing a manual look actually conflicted:
   `server.js` and `db/bootstrapPg.js` (each just needed both sides'
   additions kept side by side — new routers/permissions, not competing
   changes to the same thing), plus this file itself, `PLATFORM_BUILD.md`
   (both tracks had appended their own log entries; combined into one
   continuous history above rather than picking one side).

Pushing this unified `main` to the remote still requires the user's
explicit go-ahead before it happens, per the standing rule — the merge
work itself was authorized, but the push is a separate, fresh ask.
