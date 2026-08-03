-- SH Check-in/out schema

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT NOT NULL UNIQUE,
  days TEXT NOT NULL DEFAULT 'both' CHECK(days IN ('monday','wednesday','both')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_day TEXT NOT NULL CHECK(session_day IN ('monday','wednesday')),
  session_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent')),
  source TEXT NOT NULL DEFAULT 'kiosk',
  reason TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, session_date)
);

CREATE TABLE IF NOT EXISTS checkouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_day TEXT NOT NULL CHECK(session_day IN ('monday','wednesday')),
  session_date TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 80),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, session_date)
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_day, session_date);
CREATE INDEX IF NOT EXISTS idx_checkouts_session ON checkouts(session_day, session_date);
CREATE INDEX IF NOT EXISTS idx_members_barcode ON members(barcode);
