-- SH Check-in/out schema

-- member_type distinguishes a Student (attends co-op, can be checked in/out
-- and marked absent/late) from a Parent (submits forms and volunteers, but
-- is never checked in) from an Admin (co-op staff/leaders who mainly just
-- need a printable badge). Every member is its own profile regardless of
-- type; family_id is a simple, symmetric grouping - any members sharing
-- the same family_id are "family" (used to group names on the public
-- Absence/Late and Name Tag forms). NULL means the member isn't
-- connected to anyone.
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  member_type TEXT NOT NULL DEFAULT 'student' CHECK(member_type IN ('student','parent','admin')),
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  email TEXT,
  photo_path TEXT,
  birthday TEXT,
  grade_level TEXT,
  medical_notes TEXT,
  family_id INTEGER,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Which day's class schedule to pull Arrival/Departure from ('monday' /
  -- 'wednesday' / NULL = both days combined). Set on the manage page.
  schedule_day TEXT
);

-- The specific calendar dates that make up a roster's columns.
CREATE TABLE IF NOT EXISTS roster_dates (
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  PRIMARY KEY (roster_id, session_date)
);

-- Members can belong to more than one roster. scheduled_arrival/departure
-- are a member's usual drop-off/pick-up time for this roster (edited only
-- on the manage page) - separate from the actual per-date kiosk
-- check-in/check-out timestamps recorded in attendance/checkouts.
CREATE TABLE IF NOT EXISTS roster_members (
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  scheduled_arrival TEXT,
  scheduled_departure TEXT,
  PRIMARY KEY (roster_id, member_id)
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

-- There are exactly two volunteer lists, one per volunteer day, each
-- optionally linked to a roster so it shows on that roster's view page.
CREATE TABLE IF NOT EXISTS volunteer_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE CHECK(day IN ('monday','wednesday')),
  roster_id INTEGER REFERENCES rosters(id) ON DELETE SET NULL
);

-- The 4 admin-labeled hour blocks used to group a volunteer list's names.
CREATE TABLE IF NOT EXISTS volunteer_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  volunteer_list_id INTEGER NOT NULL REFERENCES volunteer_lists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  UNIQUE(volunteer_list_id, position)
);

-- Session dates for a volunteer list, admin-chosen and editable any time
-- (same pattern as roster_dates).
CREATE TABLE IF NOT EXISTS volunteer_dates (
  volunteer_list_id INTEGER NOT NULL REFERENCES volunteer_lists(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  PRIMARY KEY (volunteer_list_id, session_date)
);

-- Members on a volunteer list, each assigned to one or more of its 4
-- sections (one row per member+section pairing, so a member can float
-- across multiple hours on the same day).
CREATE TABLE IF NOT EXISTS volunteer_members (
  volunteer_list_id INTEGER NOT NULL REFERENCES volunteer_lists(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES volunteer_sections(id) ON DELETE CASCADE,
  PRIMARY KEY (volunteer_list_id, member_id, section_id)
);

-- Position/room filled in per volunteer per date - can differ every session.
CREATE TABLE IF NOT EXISTS volunteer_assignments (
  volunteer_list_id INTEGER NOT NULL REFERENCES volunteer_lists(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  position TEXT,
  room TEXT,
  PRIMARY KEY (volunteer_list_id, member_id, session_date)
);

-- Setup/Cleanup teams: unlike volunteer lists, there's no fixed count per
-- day, no dates, no hours, and no roster link - just an admin-titled team
-- with a short description and a plain list of member names.
CREATE TABLE IF NOT EXISTS setup_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL CHECK(day IN ('monday','wednesday')),
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS setup_team_members (
  team_id INTEGER NOT NULL REFERENCES setup_teams(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
);

-- Submissions from the public Name Tag form (lost tag / schedule change).
CREATE TABLE IF NOT EXISTS name_tag_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK(request_type IN ('lost_tag','schedule_change')),
  day TEXT NOT NULL CHECK(day IN ('monday','wednesday','both')),
  description TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The printable badge design an admin lays out - one per member type,
-- since Students, Parents, and Admins each show different fields.
-- layout_json is an array of positioned elements (text field / shape /
-- image / barcode); see utils/nameTagBadge.js for the shape.
CREATE TABLE IF NOT EXISTS name_tag_templates (
  member_type TEXT PRIMARY KEY CHECK(member_type IN ('student','parent','admin')),
  layout_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A member's weekly class schedule: up to 4 classes on Monday and 4 on
-- Wednesday (the co-op's only two session days). Each row is one class
-- period; a day with fewer than 4 classes just has fewer rows, not blank
-- placeholders - the UI fills in blank rows up to 4 for display/print.
CREATE TABLE IF NOT EXISTS member_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK(day IN ('monday','wednesday')),
  class_number INTEGER NOT NULL CHECK(class_number BETWEEN 1 AND 4),
  time TEXT,
  class_name TEXT,
  room TEXT,
  teacher TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, day, class_number)
);

-- The printable Schedule Card design an admin lays out - one shared
-- layout for every member (unlike name tags, schedule cards aren't
-- specialized per member type). Single-row table, same layout_json shape
-- as name_tag_templates; see utils/scheduleCardBadge.js.
CREATE TABLE IF NOT EXISTS schedule_card_templates (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  layout_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master Class Schedule: a real, shared class roster (distinct from the
-- freeform per-member member_schedules cards above). Each day has 4 hour
-- slots; class_schedule_hours gives each slot a per-day label (mirrors
-- volunteer_sections), and classes sit in one of those slots.
CREATE TABLE IF NOT EXISTS class_schedule_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL CHECK(day IN ('monday','wednesday')),
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4),
  label TEXT NOT NULL DEFAULT '',
  UNIQUE(day, position)
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL CHECK(day IN ('monday','wednesday')),
  hour_position INTEGER NOT NULL CHECK(hour_position BETWEEN 1 AND 4),
  class_name TEXT NOT NULL,
  room TEXT,
  age_group TEXT,
  color TEXT NOT NULL DEFAULT '#EE9A4D',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Students enrolled in a class - drives the headcount shown on the grid.
CREATE TABLE IF NOT EXISTS class_enrollments (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, student_id)
);

-- Teachers/assistants on a class - an unlimited number of each, either
-- admin-assigned or self-signed-up from the public edit-mode page.
CREATE TABLE IF NOT EXISTS class_staff (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK(role IN ('teacher','assistant')),
  PRIMARY KEY (class_id, member_id)
);

-- Small generic key/value store for one-off app-wide toggles - currently
-- just whether the public Class Schedule page allows self-signup.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Substitutes pilot (Volunteers > Substitutes): permanent jobs are duties
-- that need a person every single session at a given hour (e.g. "Front
-- Desk"), separate from both class teaching and Setup/Cleanup teams - an
-- admin-managed list, not reused from either.
CREATE TABLE IF NOT EXISTS permanent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL CHECK(day IN ('monday','wednesday')),
  hour_position INTEGER NOT NULL CHECK(hour_position BETWEEN 1 AND 4),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Floaters an admin has pre-marked as good fits for a permanent job -
-- preferred over the general floater-for-that-hour list when suggesting
-- who should fill it.
CREATE TABLE IF NOT EXISTS permanent_job_floaters (
  job_id INTEGER NOT NULL REFERENCES permanent_jobs(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, member_id)
);

-- One row per hour-slot (a class needing a sub, or a permanent job) an
-- admin has actually assigned for a specific date - suggestions
-- themselves are computed on the fly, not stored; this only holds what
-- was accepted or manually chosen. slot_type + slot_id together point at
-- either a classes.id or a permanent_jobs.id (polymorphic, so no direct
-- foreign key - both parents clear their own rows here on delete).
CREATE TABLE IF NOT EXISTS substitute_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL,
  slot_type TEXT NOT NULL CHECK(slot_type IN ('class','job')),
  slot_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  is_override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_date, slot_type, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(roster_id, session_date);
CREATE INDEX IF NOT EXISTS idx_checkouts_session ON checkouts(roster_id, session_date);
CREATE INDEX IF NOT EXISTS idx_members_barcode ON members(barcode);
CREATE INDEX IF NOT EXISTS idx_roster_members_member ON roster_members(member_id);
CREATE INDEX IF NOT EXISTS idx_roster_dates_date ON roster_dates(session_date);
CREATE INDEX IF NOT EXISTS idx_volunteer_members_section ON volunteer_members(section_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_dates_date ON volunteer_dates(session_date);
CREATE INDEX IF NOT EXISTS idx_setup_teams_day ON setup_teams(day);
