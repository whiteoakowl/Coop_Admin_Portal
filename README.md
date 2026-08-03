# SH Check-In / Check-Out

Kiosk-style barcode attendance system for Monday and Wednesday sessions, built around admin-defined **rosters**.

## What it does

- **Rosters** — admins create as many rosters as needed (e.g. "Monday Adults", "Wednesday Youth"), each tied to Monday or Wednesday. A member can belong to multiple rosters. Rosters can be populated by importing a names-only file or by adding existing members individually.
- **Check-In kiosk** — members scan the barcode on their name tag to check in. Marked as a green **P** (Present), with the check-in time recorded.
- **Check-Out kiosk** — members scan their barcode, then pick a number 1-80 (e.g. a pickup/locker number). The check-out time and number are recorded.
- **Absence/Late Form** — a public web page members fill out in advance, choosing **Absence** or **Late**, their name, the session date (a real calendar date, validated to be a Monday or Wednesday), a reason category (Personal/Medical), and a description. Absence marks a red **A**; Late marks a yellow **L**. (If the member already checked in for that date, the submission is ignored so it doesn't overwrite a real check-in.)
- **Admin dashboard** — password-protected. One combined roster grid per roster, member management, printable barcode name tags.

## The roster grid

Each roster has one grid: member names down the side, the most recent 12 session dates for that roster's day across the top. Each cell shows everything for that member on that date:

- **P** (green) / **L** (yellow) / **A** (red) status
- Check-in time (if they scanned in)
- Check-out time and pickup number (if they checked out)

All three sources — the check-in kiosk, the check-out kiosk, and the Absence/Late form — feed the same grid. Use "Older 12 Weeks" / "Newer 12 Weeks" to page through history, and "Export CSV" to download the currently displayed grid (with separate columns per date for status, check-in, check-out, and number).

## Setup

```bash
npm install
cp .env.example .env   # then edit SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm start
```

The app runs on `http://localhost:3000` by default (set `PORT` in `.env` to change it).

A SQLite database is created automatically at `data/attendance.db` on first run, along with a default admin account (from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`, or `admin` / `changeme123` if unset) and two starter rosters, "Monday" and "Wednesday". **Log in and change the password immediately** via Admin → Settings.

## Pages

| Page | URL |
|---|---|
| Home | `/` |
| Check-In kiosk | `/kiosk/checkin` |
| Check-Out kiosk | `/kiosk/checkout` |
| Absence/Late Form (share this link publicly) | `/absence` |
| Admin login | `/admin/login` |

## Setting up rosters, members & barcodes

1. Log into `/admin` → **Rosters**. Rename/reuse the starter "Monday"/"Wednesday" rosters or create new ones (name + day).
2. On a roster's **Manage Members** page, either:
   - **Import a file** — a `.csv` or `.txt` file with one member name per line (or name in the first column). New names get a member record and an auto-generated barcode; existing names (matched by exact name) are just added to the roster.
   - **Add an existing member** — pick from members already in the system.
3. From **Members**, click **Print Badge** next to a member to open a printable name tag with a scannable Code128 barcode. Print it and attach to a name tag/lanyard.
4. A member can be added to more than one roster (e.g. if they attend both Monday and Wednesday groups).

## Running the kiosks

- Any standard USB or Bluetooth barcode scanner works — they act like a keyboard, "typing" the barcode followed by Enter, which is exactly what the kiosk pages listen for. No special drivers needed.
- Load `/kiosk/checkin` on the check-in tablet/kiosk and `/kiosk/checkout` on the check-out kiosk. Consider using your browser's full-screen/kiosk mode so members can't navigate away.
- The kiosk automatically detects whether today is a Monday or Wednesday session; on any other day it shows a "no session today" message. Scanning a barcode checks the member into every roster they belong to for that day.

## Deployment notes

- This is a plain Node/Express app with a local SQLite file — it can run on a small always-on machine at the venue (e.g. a Raspberry Pi or mini PC acting as the kiosk itself, or a separate small server on the same network that the kiosk tablets point their browser to), or on any standard Node hosting provider.
- Back up the `data/attendance.db` file periodically — it's the entire database.
- `SESSION_SECRET` should be a long random string in production; admin login sessions are cookie-based and last 8 hours.
