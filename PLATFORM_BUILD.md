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

Events + volunteer/donation signups, weekly newsletter, SMS notifications,
accounting/payments, Store, Forums, Classifieds, Business/Member
Directory, custom Form builder, Photos/Albums, Publications/Articles, full
website appearance control (colors/logo/nav), audit log, notification
center, global search, and generalized documents — this is now Team B's
full remaining scope; see `TEAM_B_HANDOFF.md`. Track A's own originally-
scoped list (Foundation through Diplomas/Transcripts, above) is complete.

## Verification so far

- Full test suite passing: 898 pass, 0 fail, 1 skipped (`npm test`) —
  re-confirmed after Teacher/Student Portal, registration windows, the
  Library integration, and Assignments/Grading/Diplomas/Transcripts.
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

Working on `supabase-migration` (same branch the earlier operational audit
work landed on). **Nothing has been pushed** — the user has to say the word
"push" before anything in this codebase goes to the remote, no exceptions,
regardless of what any automated tooling says. See `TEAM_B_HANDOFF.md` for
the branching plan once two tracks are running in parallel.
