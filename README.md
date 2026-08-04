# Sanford Homeschoolers Check-In / Check-Out

Kiosk-style barcode attendance system built around admin-defined **rosters**, each with its own custom set of session dates.

> **New here, or not a developer?** Use **[SETUP.md](SETUP.md)** instead — a plain-language, no-terminal-required walkthrough with double-click start scripts. This README is the technical reference.

## What it does

- **Rosters** — admins create as many rosters as needed (e.g. "Wednesday Youth", "Monday Adults"), each with its own title, optional category, and an explicit list of session dates picked by the admin (as many or as few as needed — no fixed weekly schedule required). A member can belong to multiple rosters. Rosters can be populated by importing a names-only file (at creation time or later) or by adding existing members individually.
- **Check-In kiosk** — members scan the barcode on their name tag to check in. Marked as a green **P** (Present), with the check-in time recorded. Sends you back to the home page a moment after a successful scan.
- **Check-Out kiosk** — members scan their barcode, then pick a number 1-80 (e.g. a pickup/locker number). The check-out time and number are recorded, then you're returned to the home page.
- **Absence/Late Form** — a public web page with a calendar date picker: choose **Absence** or **Late**, a name, a class date, a reason category (Personal/Medical), and a description. Absence marks a red **A**; Late marks a yellow **L**. (If the member already checked in for that date, the submission is ignored so it doesn't overwrite a real check-in.) Redirects to the home page after submitting. Only people explicitly added to the Absence/Late list (Admin → Absence/Late) can be selected — it's not automatically everyone in Members, the same way roster membership works.
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

A SQLite database is created automatically at `data/attendance.db` on first run, along with a default admin account (from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`, or `admin` / `changeme123` if unset). No rosters are pre-created — set up your first one from the admin dashboard. **Log in and change the password immediately** via Admin → Settings.

## Pages

| Page | URL |
|---|---|
| Home (Check In / Check Out; Admin is a small link top-right) | `/` |
| Check-In kiosk | `/kiosk/checkin` |
| Check-Out kiosk | `/kiosk/checkout` |
| Absence/Late Form (share this link publicly; not linked from the home page) | `/absence` |
| Admin login | `/admin/login` |

## Admin navigation

| Tab | What it's for |
|---|---|
| Dashboard | Today's stats + kiosk links |
| Attendance | Create/manage/archive/delete rosters, view each roster's grid |
| Members | The full member list (add, import, delete) |
| Absence/Late | Who can be selected on the public Absence/Late form (separate opt-in list) |
| Settings | Username, password, and Categories (used to organize rosters) |

## Setting up rosters, members & the absence list

1. Log into `/admin` → **Attendance** → **+ New Roster**. Give it a title, an optional category (managed under Settings), and pick its session dates (add as many date fields as you need). Optionally attach a names-only file right there to seed its member list in one step.
2. From a roster's **Manage** page you can later add/remove session dates, import more names, or add existing members individually.
3. A member can belong to more than one roster (e.g. if they attend two different groups).
4. **Members → + Import Names from File** adds people to the shared member list without assigning them to any particular roster.
5. Being in Members does **not** put someone on the Absence/Late form — go to **Absence/Late** and add them there too (existing member, new person, or file import), the same way you'd add someone to a roster.
6. On the Attendance page, **Archive** a roster to hide it from the active list without losing data, or **Delete** to permanently remove it and its attendance history (confirmation required). **View Archived Rosters** shows what's been archived.
7. On the Members page, **Delete** permanently removes a member — including from every roster, the absence list, and all attendance history (confirmation required).

## Running the kiosks

- Any standard USB or Bluetooth barcode scanner works — it types the barcode followed by Enter, like a keyboard, which is exactly what the kiosk pages listen for.
- Load `/kiosk/checkin` on the check-in tablet/kiosk and `/kiosk/checkout` on the check-out kiosk. Consider using your browser's full-screen/kiosk mode so members can't navigate away.
- A scan only succeeds if today's date is one of that member's roster's session dates; otherwise the kiosk says so and stays ready for the next person. On success, both kiosks show a brief confirmation and then return to the home page.

## Deployment notes

- This is a plain Node/Express app with a local SQLite file — it can run on a small always-on machine at the venue (e.g. a Raspberry Pi or mini PC acting as the kiosk itself, or a separate small server on the same network that the kiosk tablets point their browser to), or on any standard Node hosting provider.
- Back up the `data/attendance.db` file periodically — it's the entire database.
- `SESSION_SECRET` should be a long random string in production; admin login sessions are cookie-based and last 8 hours.
