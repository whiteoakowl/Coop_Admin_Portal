# Sanford Homeschoolers Check-In / Check-Out

Kiosk-style barcode attendance system built around **rosters** with their own custom set of session dates - a fixed set (Monday/Wednesday Parents and Students) plus one auto-maintained roster per class.

> **New here, or not a developer?** Use **[SETUP.md](SETUP.md)** instead — a plain-language, no-terminal-required walkthrough with double-click start scripts. This README is the technical reference.

## What it does

- **Rosters** — an explicit list of session dates per roster, picked by the admin (as many or as few as needed — no fixed weekly schedule required). Four rosters always exist (Monday/Wednesday × Parents/Students); each class set up under Schedules gets its own too. A member can be on more than one at once. Populated automatically from Schedules enrollment/staffing, or by adding existing members individually from the roster's own page.
- **Check-In kiosk** — members scan the barcode on their name tag to check in. Marked as a green **P** (Present), with the check-in time recorded. Sends you back to the home page a moment after a successful scan.
- **Check-Out kiosk** — members scan their barcode. Students are checked out immediately with a "Have a great day!" message. Parents then scan the Setup/Cleanup badge for the task they completed instead of choosing a pickup number (badges are generated automatically from the Setup/Cleanup task list - see the Admin pages table below). Either way the check-out time is recorded and you're returned to the home page.
- **Absence/Late Form** — a public web page with a calendar date picker: an existing parent picks their own name, then which of their kids (or themselves), a class date, a reason category (Personal/Medical), and a description. Absence marks a red **A**; Late marks a yellow **L**. (If the member already checked in for that date, the submission is ignored so it doesn't overwrite a real check-in.) Redirects to the home page after submitting. No separate setup needed — every active parent and their family can already be selected.
- **Admin dashboard** — password-protected. Active members / checked in / late / absent today at a glance, plus links to the kiosks and the public Absence/Late form.

## Barcodes

Barcodes are Code128 and read as the member's plain name — a new member's barcode defaults to their name (editable if two people share a name or existing ID cards use different values). Any standard USB barcode scanner works as a plug-and-play keyboard-emulating device; no drivers or configuration needed.

## The roster grid

Each roster has one grid: member names down the side, that roster's specific session dates across the top. Each cell shows everything for that member on that date:

- **P** (green) / **L** (yellow) / **A** (red) status
- Check-in time (if they scanned in)
- Check-out time and, for a parent, which Setup/Cleanup task they scanned (if they checked out)

All three sources — the check-in kiosk, the check-out kiosk, and the Absence/Late form — feed the same grid. The bottom of the table totals how many were Present / Late / Absent for each date. Below the grid, an Absence/Late Submissions table lists every form submission for that roster (name, date, status, reason, description), filterable to a single date. Use **Export CSV** to download the grid, or **Print** for a print-friendly landscape layout.

## Setup

Double-click `start-mac.command` (Mac) or `start-windows.bat` (Windows) — it installs dependencies, creates `.env` from the example file, starts the server, and opens your browser automatically. See [SETUP.md](SETUP.md) for the full non-technical walkthrough.

Or, from a terminal:

```bash
npm install
cp .env.example .env   # then edit SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm start
```

The app runs on `http://localhost:3000` by default (set `PORT` in `.env` to change it). On startup it also prints the address other devices on the same wifi can use to reach it (e.g. `http://192.168.1.42:3000`) — useful for pointing a second kiosk device at the server without hunting down its IP manually.

A SQLite database is created automatically at `data/attendance.db` on first run, along with a default admin account (from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`, or `admin` / `changeme123` if unset) and the four built-in Monday/Wednesday Parent/Student rosters (still empty until you add members and session dates). **Log in and change the password immediately** via Admin → Settings.

## Pages

| Page | URL |
|---|---|
| Home (Check In / Check Out / Volunteers; Admin is a small link top-right) | `/` |
| Check-In kiosk | `/kiosk/checkin` |
| Check-Out kiosk | `/kiosk/checkout` |
| Monday / Wednesday Volunteers (today's schedule, no login) | `/volunteers/monday`, `/volunteers/wednesday` |
| Absence/Late Form (share this link publicly; not linked from the home page) | `/absence` |
| Admin login | `/admin/login` |

## Admin navigation

| Tab | What it's for |
|---|---|
| Home | Today's stats + kiosk links |
| Attendance | The Monday/Wednesday Parent and Student rosters (always exist) plus each class's own auto-maintained roster - session dates, attendance grid, adding members |
| Floater Assignments | Manage the Monday and Wednesday volunteer schedules |
| Setup/Cleanup | Setup/Cleanup teams and task lists |
| Schedules | Classes, hours, rooms, and enrollment/staffing - see "Setting up rosters & members" below |
| Logs | Absence/late submissions, check-in/out history, the allergy/medical log, and name tag requests |
| Members | The full member list (add, import, delete) |
| Library | Checkout/checkin for library items |
| Documents | Uploaded PDFs/Word docs shown on the public Documents page |
| Design/Print | Name tag and schedule card design, badge printing |
| Settings | Username/password, Quick Links, Install App, Documents, and Backup/Restore |

## Admin access model

There's currently only **one** admin account/role - the single master Admin created on first run (or via `ADMIN_USERNAME`/`ADMIN_PASSWORD` at setup). Despite that, the codebase uses three differently-named touchpoints for the exact same check (whether `req.session.adminId` is set):

- `middleware/requireAdmin.js` - the baseline route gate.
- `middleware/requireFullAdmin.js` - functionally identical today, mounted via a blanket `router.use(requireFullAdmin)` on the routers for Members, Library, Design/Print, Documents, Name Tag, and global Search.
- `res.locals.isFullAdmin` (set once per request in `server.js`) - the same check again, exposed to every EJS view for conditional nav/UI (e.g. hiding the Members tab from the sidebar).

They're kept separate on purpose, not by oversight: if a lesser/restricted admin role is ever introduced, each of these three touchpoints can diverge independently (a route moves from `requireAdmin` to `requireFullAdmin`, a nav link's `isFullAdmin` check tightens) without a site-wide audit of every route to work out which ones were "supposed" to already be more restrictive. Until that day, treat them as one identical check with three names, not three access tiers - a route gated only by `requireAdmin` isn't any more open to a "regular" admin than one gated by `requireFullAdmin`, because there is no other kind of admin yet.

One consequence worth knowing before adding a new route: a handful of routers (`admin-design.js`, `admin-documents.js`, `admin-library.js`, `admin-members.js`, `admin-name-tag.js`, `admin-search.js`) gate their *entire* router with a single `router.use(requireFullAdmin)` at the top, rather than per-route middleware - every route in those files is already full-admin-gated before it's ever reached, so there's no need to also list `requireAdmin`/`requireFullAdmin` on individual routes within them. Routers without that blanket `.use()` (e.g. `admin-schedule.js`, `admin-class-schedule.js`) mix `requireAdmin` and `requireFullAdmin` per-route deliberately, matching each route's actual restriction level.

## Volunteers

There are two fixed volunteer lists, Monday and Wednesday, managed from the **Floater Assignments** tab. Each list can optionally be linked to a roster so it shows on that roster's view page next to the attendance grid.

- Names are grouped into 4 admin-labeled hour sections (e.g. "9-10am", "Nursery", etc. - whatever your co-op calls its shifts).
- Session dates are chosen by the admin, just like a roster's dates, and can be added or removed any time.
- Each volunteer's **position** and **room number** are filled in per session date - they can be different every week - either from the volunteer list's own manage page (all dates at once) or from the linked roster's view page (one date at a time, via a date dropdown above the volunteer box).
- The public homepage has **Monday Volunteers** / **Wednesday Volunteers** buttons (no login needed) that show that day's schedule for whichever date is today, grouped by section, for a screen members can walk up to and scroll through. That screen returns to the home page automatically after 20 seconds of no interaction.

## Setting up rosters & members

Rosters aren't something you create by hand anymore - there's a fixed set of them, and membership on them is mostly automatic:

1. **Members** is where every person starts: **+ Add Member** for one at a time, or **Import from File** for a whole group at once (`.csv`/`.txt`/`.xlsx`).
2. **Attendance** always has four rosters - **Monday Parents**, **Monday Students**, **Wednesday Parents**, **Wednesday Students** - plus a **Class Rosters** tab listing each individual class's own roster. Each of those tabs has its own **+ Add Dates** (session dates) and **+ Add Member** (pick from existing Members) controls.
3. **Schedules** is the faster path for a full class list: creating a class and enrolling/staffing members onto it automatically adds them to that class's own roster *and* to their day's Parent/Student roster in Attendance - nothing to add by hand in both places.
4. A member can be on more than one roster at once (e.g. two classes, or both a Monday and Wednesday roster) with no extra setup.
5. The public Absence/Late form (`/absence`) needs no separate setup either - every active parent (member_type `parent`) can already be selected there, along with anyone sharing their `family_id` (set via **Choose a Family** on the member form). Submissions land in **Logs → Absence** for review.
6. On the Members page, **Delete** permanently removes a member and cascades to their roster memberships and attendance history (confirmation required) - there's no separate "remove from absence list" step since that list isn't separately maintained.

## Archiving

Two different, deliberately incompatible "archiving" patterns exist side by side, chosen per feature based on what should happen to the archived data - if you're adding a new feature that needs some notion of archiving, pick whichever one actually matches what you need rather than copying the nearest example by habit.

1. **In-place flag (reversible, non-destructive).** Name Tag requests (**Logs → Name Tag** and the **Design/Print → Print** tab's own requests list) work this way: archiving just flips that row's `archived` column from 0 to 1, in the same table, nothing moves or transforms - and it's just as reversible (**Unarchive**). This fits a review queue: an admin works through a list of pending items, and "archived" really just means "already handled, hide it from the default view" - the original submission is still exactly what it was, still individually inspectable either way. `contact_admin_messages` and `membership_requests` carry the same `archived` column for the same reason (they're queues too), though neither has an admin review screen wired up yet to actually flip it.
2. **Snapshot-and-clear (self-contained, one-way).** The Attendance page's **Archive** button (one day at a time) works completely differently: it takes a full point-in-time copy of that day's Parent, Student, and every class roster - session dates, attendance, checkouts - and bakes it into one `roster_archives` row as JSON, with member names and statuses written directly into the snapshot rather than as `member_id` references, so the record stays accurate forever even if a member in it is later deleted from the system entirely. Archiving then **clears** the live data it just captured, so the live Attendance grid starts the next term with a clean slate. There's no "unarchive" - a term-end snapshot is a permanent historical record, browsed through its own log list and viewable/printable/exportable from there, never flowing back into the live grid.

A third, lighter pattern shows up on the Volunteers page too, worth knowing about even though it isn't really "archiving" in either sense above: a volunteer assignment date only counts as archived once it's simply in the past - nothing is flagged or snapshotted, it's a live filter over whatever dates already exist. Nothing to write or reverse; that "archive" view is just "the dates that have already happened."

## Running the kiosks

- Any standard USB or Bluetooth barcode scanner works — it types the barcode followed by Enter, like a keyboard, which is exactly what the kiosk pages listen for.
- Load `/kiosk/checkin` on the check-in tablet/kiosk and `/kiosk/checkout` on the check-out kiosk. Consider using your browser's full-screen/kiosk mode so members can't navigate away.
- A scan only succeeds if today's date is one of that member's roster's session dates; otherwise the kiosk says so and stays ready for the next person. On success, both kiosks show a brief confirmation and then return to the home page.

## Deployment notes

- This is a plain Node/Express app with a local SQLite file — it can run on a small always-on machine at the venue (e.g. a Raspberry Pi or mini PC acting as the kiosk itself, or a separate small server on the same network that the kiosk tablets point their browser to), or on any standard Node hosting provider.
- Back up periodically — it's the entire app's data. The easiest way is the **Back Up Now** button on Admin → Settings (Username/Password tab), which downloads a single `.shcbackup` file containing a safe, point-in-time copy of the database *and* every uploaded file (member photos, documents, name tag/schedule card design images), bundled together. The database portion uses SQLite's own `VACUUM INTO` mechanism, so it's always a consistent snapshot even while the app is running — unlike copying the live `data/attendance.db` file directly, which can grab it mid-write. The file isn't a real `.zip`/`.tar` — nothing needs to open it directly, since it only ever round-trips back through this app's own Restore button — so don't expect a general-purpose archive tool to read it.
- To restore one, use **Restore** right below it on the same tab: upload the `.shcbackup` file (an older, database-only `.db` backup from before this file also captured uploads still works too, just without restoring any files), and it's validated on the spot (the database portion has to actually be a backup of this app's database, with at least one admin account in it — anything else is rejected with an explanation, nothing is changed). A valid upload is staged, not applied immediately; **close and reopen the app** (the same way you already start/stop it — see Step 3 in [SETUP.md](SETUP.md)) to finish the restore. That one extra step is deliberate — there's no way to safely swap out a database file already in use by a running server, so the app never applies a restore silently underneath you. Restoring replaces the current uploaded files wholesale with the backup's set, the same as it does for the database. A staged restore can be cancelled from the same page any time before that restart.
- `SESSION_SECRET` should be a long random string in production; admin login sessions are cookie-based and last 8 hours.
- The session cookie is marked `Secure` automatically whenever the connection actually is HTTPS, so plain `http://` on a closed LAN (the typical kiosk setup) keeps working with no extra config. If you put this behind a TLS-terminating reverse proxy (nginx, Caddy, a tunnel) instead of running it directly, set `TRUST_PROXY=1` in `.env` so it trusts that proxy's `X-Forwarded-Proto` header — don't set this unless a real proxy is actually in front of the app, since it lets whoever sends that header influence cookie security otherwise.
