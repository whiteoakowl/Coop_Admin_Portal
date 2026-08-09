# Sanford Homeschoolers Check-In / Check-Out

Kiosk-style barcode attendance system built around **rosters** with their own custom set of session dates - a fixed set (Monday/Wednesday Parents and Students) plus one auto-maintained roster per class.

> **New here, or not a developer?** Use **[SETUP.md](SETUP.md)** instead — a plain-language, no-terminal-required walkthrough with double-click start scripts. This README is the technical reference.

## What it does

- **Rosters** — an explicit list of session dates per roster, picked by the admin (as many or as few as needed — no fixed weekly schedule required). Four rosters always exist (Monday/Wednesday × Parents/Students); each class set up under Schedules gets its own too. A member can be on more than one at once. Populated automatically from Schedules enrollment/staffing, or by adding existing members individually from the roster's own page.
- **Check-In kiosk** — members scan the barcode on their name tag to check in. Marked as a green **P** (Present), with the check-in time recorded. Sends you back to the home page a moment after a successful scan.
- **Check-Out kiosk** — members scan their barcode, then pick a number 1-80 (e.g. a pickup/locker number). The check-out time and number are recorded, then you're returned to the home page.
- **Absence/Late Form** — a public web page with a calendar date picker: an existing parent picks their own name, then which of their kids (or themselves), a class date, a reason category (Personal/Medical), and a description. Absence marks a red **A**; Late marks a yellow **L**. (If the member already checked in for that date, the submission is ignored so it doesn't overwrite a real check-in.) Redirects to the home page after submitting. No separate setup needed — every active parent and their family can already be selected.
- **Admin dashboard** — password-protected. Active members / checked in / late / absent today at a glance, plus links to the kiosks and the public Absence/Late form.

## Barcodes

Barcodes are Code128 and read as the member's plain name — a new member's barcode defaults to their name (editable if two people share a name or existing ID cards use different values). Any standard USB barcode scanner works as a plug-and-play keyboard-emulating device; no drivers or configuration needed.

## The roster grid

Each roster has one grid: member names down the side, that roster's specific session dates across the top. Each cell shows everything for that member on that date:

- **P** (green) / **L** (yellow) / **A** (red) status
- Check-in time (if they scanned in)
- Check-out time and pickup number (if they checked out)

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

## Running the kiosks

- Any standard USB or Bluetooth barcode scanner works — it types the barcode followed by Enter, like a keyboard, which is exactly what the kiosk pages listen for.
- Load `/kiosk/checkin` on the check-in tablet/kiosk and `/kiosk/checkout` on the check-out kiosk. Consider using your browser's full-screen/kiosk mode so members can't navigate away.
- A scan only succeeds if today's date is one of that member's roster's session dates; otherwise the kiosk says so and stays ready for the next person. On success, both kiosks show a brief confirmation and then return to the home page.

## Deployment notes

- This is a plain Node/Express app with a local SQLite file — it can run on a small always-on machine at the venue (e.g. a Raspberry Pi or mini PC acting as the kiosk itself, or a separate small server on the same network that the kiosk tablets point their browser to), or on any standard Node hosting provider.
- Back up the database periodically — it's the entire app's data. The easiest way is the **Back Up Now** button on Admin → Settings (Username/Password tab), which downloads a safe, point-in-time copy you can save anywhere (a cloud drive, a USB stick). It uses SQLite's own `VACUUM INTO` mechanism, so it's always a consistent snapshot even while the app is running — unlike copying the live `data/attendance.db` file directly, which can grab it mid-write.
- To restore one, use **Restore** right below it on the same tab: upload the `.db` file, and it's validated on the spot (it has to actually be a backup of this app's database, with at least one admin account in it — anything else is rejected with an explanation, nothing is changed). A valid upload is staged, not applied immediately; **close and reopen the app** (the same way you already start/stop it — see Step 3 in [SETUP.md](SETUP.md)) to finish the restore. That one extra step is deliberate — there's no way to safely swap out a database file already in use by a running server, so the app never applies a restore silently underneath you. A staged restore can be cancelled from the same page any time before that restart.
- `SESSION_SECRET` should be a long random string in production; admin login sessions are cookie-based and last 8 hours.
- The session cookie is marked `Secure` automatically whenever the connection actually is HTTPS, so plain `http://` on a closed LAN (the typical kiosk setup) keeps working with no extra config. If you put this behind a TLS-terminating reverse proxy (nginx, Caddy, a tunnel) instead of running it directly, set `TRUST_PROXY=1` in `.env` so it trusts that proxy's `X-Forwarded-Proto` header — don't set this unless a real proxy is actually in front of the app, since it lets whoever sends that header influence cookie security otherwise.
