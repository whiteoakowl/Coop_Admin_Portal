# SH Check-In / Check-Out

Kiosk-style barcode attendance system for Monday and Wednesday sessions.

## What it does

- **Check-In kiosk** — members scan the barcode on their name tag to check in. Marked as a green **P** (Present) on the roster.
- **Check-Out kiosk** — members scan their barcode, then pick a number 1-80 (e.g. a pickup/locker number). Recorded on a separate checkout roster.
- **Absence form** — a public web page members can fill out in advance to report they'll miss a session. Marked as a red **A** (Absent) on the roster. (If the member already checked in that day, the absence submission is ignored so it doesn't overwrite a real check-in.)
- **Admin dashboard** — password-protected. View/export rosters, manage members, print barcode name tags.
- Everything is tracked **separately for Monday and Wednesday**, and the check-in/absence roster is separate from the checkout roster.

## Roster views

Each roster is a grid: member names down the side, the most recent 12 session dates across the top.

- `Attendance` rosters (Monday & Wednesday): green `P` / red `A` per date.
- `Checkout` rosters (Monday & Wednesday): the picked number (1-80) per date.

Use the "Older 12 Weeks" / "Newer 12 Weeks" links to page through history, and "Export CSV" to download the currently displayed grid.

## Setup

```bash
npm install
cp .env.example .env   # then edit SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm start
```

The app runs on `http://localhost:3000` by default (set `PORT` in `.env` to change it).

A SQLite database is created automatically at `data/attendance.db` on first run, along with a default admin account (from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`, or `admin` / `changeme123` if unset). **Log in and change the password immediately** via Admin → Settings.

## Pages

| Page | URL |
|---|---|
| Home | `/` |
| Check-In kiosk | `/kiosk/checkin` |
| Check-Out kiosk | `/kiosk/checkout` |
| Absence form (share this link publicly) | `/absence` |
| Admin login | `/admin/login` |

## Setting up members & barcodes

1. Log into `/admin`, go to **Members**, and add each person with a name and which day(s) roster they belong to (Monday, Wednesday, or both).
2. Leave the barcode field blank to auto-generate a unique code, or type in an existing barcode number if members already have ID cards.
3. Click **Print Badge** next to a member to open a printable name tag with a scannable Code128 barcode. Print it (or a batch, one at a time) and attach to name tags/lanyards.

## Running the kiosks

- Any standard USB or Bluetooth barcode scanner works — they act like a keyboard, "typing" the barcode followed by Enter, which is exactly what the kiosk pages listen for. No special drivers needed.
- Load `/kiosk/checkin` on the check-in tablet/kiosk and `/kiosk/checkout` on the check-out kiosk. Consider using your browser's full-screen/kiosk mode so members can't navigate away.
- The kiosk automatically detects whether today is a Monday or Wednesday session; on any other day it shows a "no session today" message.

## Deployment notes

- This is a plain Node/Express app with a local SQLite file — it can run on a small always-on machine at the venue (e.g. a Raspberry Pi or mini PC acting as the kiosk itself, or a separate small server on the same network that the kiosk tablets point their browser to), or on any standard Node hosting provider.
- Back up the `data/attendance.db` file periodically — it's the entire database.
- `SESSION_SECRET` should be a long random string in production; admin login sessions are cookie-based and last 8 hours.
