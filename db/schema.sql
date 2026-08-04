-- SH Check-in/out schema

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Categories are managed separately (Attendance page) so the roster
-- creation form can offer a plain dropdown instead of free text.
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A roster is an admin-defined group of members with its own explicit list
-- of session dates (see roster_dates) and an optional category label.
-- Admins can create as many rosters as they need.
CREATE TABLE IF NOT EXISTS rosters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The specific calendar dates that make up a roster's columns.
CREATE TABLE IF NOT EXISTS roster_dates (
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  PRIMARY KEY (roster_id, session_date)
);

-- Members can belong to more than one roster.
CREATE TABLE IF NOT EXISTS roster_members (
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (roster_id, member_id)
);

-- Who can be selected on the public Absence/Late form - an explicit opt-in
-- list managed the same way roster membership is, not "every member."
CREATE TABLE IF NOT EXISTS absence_list_members (
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','late','absent')),
  check_in_time INTEGER, -- epoch ms, set when the kiosk records an actual check-in
  source TEXT NOT NULL DEFAULT 'kiosk', -- 'kiosk' | 'absence_form'
  reason_category TEXT CHECK(reason_category IN ('personal','medical') OR reason_category IS NULL),
  reason_text TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, roster_id, session_date)
);

CREATE TABLE IF NOT EXISTS checkouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 80),
  check_out_time INTEGER NOT NULL, -- epoch ms
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, roster_id, session_date)
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(roster_id, session_date);
CREATE INDEX IF NOT EXISTS idx_checkouts_session ON checkouts(roster_id, session_date);
CREATE INDEX IF NOT EXISTS idx_members_barcode ON members(barcode);
CREATE INDEX IF NOT EXISTS idx_roster_members_member ON roster_members(member_id);
CREATE INDEX IF NOT EXISTS idx_roster_dates_date ON roster_dates(session_date);
