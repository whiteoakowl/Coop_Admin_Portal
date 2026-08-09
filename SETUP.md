# Setup Guide — Sanford Homeschoolers Check-In / Check-Out

This guide assumes no coding experience. If you can install an app and double-click a file, you can get this running.

For a more technical reference (how the roster grid works, CSV export format, etc.), see [README.md](README.md).

## What you'll need

- A computer that can stay on and connected to wifi while sessions are happening (a laptop, a mini PC, or even the check-in kiosk laptop itself).
- A USB or Bluetooth barcode scanner for each kiosk station (check-in and check-out). Any standard one works — no special setup, it just "types" the barcode like a keyboard.
- 10–15 minutes for the one-time setup below.

---

## Step 1 — Install Node.js

This system runs on **Node.js**, a free program. Go to **[nodejs.org](https://nodejs.org)**, download the **LTS** installer for your computer (Windows or Mac), and run it like any other installer. You don't need to configure anything during install — just click through it.

## Step 2 — Get the code

Go to the project's GitHub page and download it as a zip file:

1. Open **https://github.com/whiteoakowl/sh-check-in-out**
2. Click the green **Code** button → **Download ZIP**
3. Unzip it somewhere you'll remember, like your Desktop or Documents folder

*(If you're comfortable with git, `git clone https://github.com/whiteoakowl/sh-check-in-out.git` works too.)*

## Step 3 — Start it

Open the unzipped folder and double-click the file for your computer:

- **Windows:** `start-windows.bat`
- **Mac:** `start-mac.command`

A black window will pop up and do some one-time setup (this can take a minute the very first time), then your browser will open automatically to the home page.

> **Keep that window open** while you're using the system — closing it stops the server. You can minimize it.

**First time on a Mac?** macOS may say the file is from an unidentified developer. Right-click `start-mac.command`, choose **Open**, then click **Open** again in the popup. You only need to do this once.

**Prefer using a terminal?** That works too:

```bash
npm install
cp .env.example .env
npm start
```

## Step 4 — Log in and set a real password

Go to `/admin`, or click the small **Staff Login** link on the home page. Log in with:

- Username: `admin`
- Password: `changeme123`

Then open **Settings** and change the password to something only you know. This matters most if this computer is ever reachable from outside your own wifi network.

## Step 5 — Create your first roster

If you want to group rosters by category (e.g. "Youth", "Adults", "Sports"), add those categories first: **Settings** → type a name under **Categories** → **Add**. This is the only place categories are created.

Then click **Attendance** → **+ New Roster**. Fill in:

- **Title** — whatever you call the group (e.g. "Wednesday Youth", "Monday Adults").
- **Category** — optional, pick from the categories you've already added.
- **Session Dates** — click a date field and pick a date, then **+ Add another date** for each additional session. Pick as many or as few as you want up front; you can always add more later from the roster's Manage page.

A student in two different groups just gets added to both rosters — create each roster separately and add that member to both.

## Step 6 — Add your members

Open the roster and click **Manage**. Two ways to add people:

**Import a list** (fastest for a whole group) — a plain text or spreadsheet-exported `.csv`/`.txt` file with one name per line:

```
Ava Thompson
Noah Sanders
Grace Kim
Ella Martinez
```

Upload it and the system creates a member record for each new name automatically — barcode readers here read a person's name directly, so each new member's barcode is just their name. A name that already exists elsewhere in the system just gets added to this roster too.

**Add one at a time** — pick an existing member from the dropdown (handy when adding someone to a second roster).

**Adding names without a roster yet?** Go to **Members** and use the name bar or **Import from File** to add people to the system before you've decided which roster they belong to. Note this does *not* put them on the Absence/Late form — see Step 9.

## Step 7 — Print name tags

Since barcodes are just each member's name, if your name tags/lanyards already have a scannable barcode with the person's name on them, they'll work as-is. Otherwise you'll need to produce your own barcode labels (Code128 format) with each member's exact name as it appears on the Members page.

## Step 8 — Set up the two kiosk screens

You need two screens members can walk up to:

| Kiosk | Address |
|---|---|
| Check-In | `/kiosk/checkin` |
| Check-Out | `/kiosk/checkout` |

If both kiosks are on the **same computer** you just started the server on, open each address in its own browser window/tab (e.g. `http://localhost:3000/kiosk/checkin`).

If the second kiosk is a **different device** (a tablet or second laptop) on the same wifi, look at the black terminal window from Step 3 — it prints an address like `http://192.168.1.42:3000`. Type that same address followed by `/kiosk/checkout` into the second device's browser.

For a clean walk-up screen with no browser bars, use full-screen mode: **F11** on Windows/Chromebook, or on an iPad, **Share → Add to Home Screen** so it opens like an app.

A scan only works if today's date is one of that member's roster's session dates — if not, the kiosk says so and stays ready for the next person. After a successful check-in or check-out, the kiosk shows a quick confirmation and then returns to the home page automatically.

## Step 9 — Set up and share the Absence/Late Form

Only people you explicitly add can be selected on the Absence/Late form — it doesn't automatically include everyone from Members, the same way rosters work. Go to **Absence/Late** in the nav and add people using the name bar, the existing-member dropdown, or **Import from File**.

Once that's done, send families the link to `/absence` directly (no login needed, and it's not linked from the home page on purpose) — bookmark it or add it to your co-op's newsletter/group chat. It lets them pick their name, pick a class date from a calendar, and report an absence or a late arrival in advance. It writes straight into the roster grid you see in the admin dashboard: a red **A** for absent, a yellow **L** for late.

---

## Everyday use

Once it's set up, running a session day is just:

1. Double-click the start script (Step 3) if the computer isn't already running it.
2. Open the check-in and check-out kiosk pages.
3. Members scan in, scan out with their pickup number, or you handle any last-minute absences from the admin dashboard.

## Where to run this long-term

- **Simplest:** leave it running on one laptop during sessions (the check-in laptop can double as the server).
- **More permanent:** a small always-on computer (a mini PC or Raspberry Pi) on your co-op's wifi, so nobody has to remember to start anything.
- **Remote access:** a small cloud host (Render, Railway, a basic VPS) if you want check-in/out reachable from outside your building's wifi.

## Backing up your data

Everything — every member, roster, check-in, and absence — lives in one file: `data/attendance.db`. Copy that file somewhere safe on a regular basis (a cloud drive, a USB stick, whatever's easy for you). If that file is ever lost, so is the history.

## Troubleshooting

| Problem | Try this |
|---|---|
| "Barcode not recognized" at the kiosk | Check that the member is listed under **Members**, and that their barcode matches what's shown there (barcodes are just each member's name). |
| "Not scheduled for a roster today" at the kiosk | That member's roster(s) don't include today's date. Add today as a session date from the roster's Manage page if that's unexpected. |
| Second kiosk can't reach the system | Make sure both devices are on the same wifi, and use the `http://192.168.x.x:3000` address printed in the terminal window, not `localhost`. |
| Forgot the admin password | Close the server, delete the `data` folder (this erases all data — restore from a backup afterward), then start it again to get a fresh admin account from your `.env` file. |
| Double-clicking the start file does nothing | On Mac, right-click it and choose **Open** the first time (see Step 3). On Windows, make sure the file ends in `.bat`, not `.txt`. |
