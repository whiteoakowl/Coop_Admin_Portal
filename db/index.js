const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { DEFAULT_LAYOUT: SCHEDULE_CARD_DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'attendance.db');

// If an admin staged a restore (Admin > Settings > Restore, see
// utils/backup.js) before this app was last started, swap it in now,
// before anything opens the live database - this is the one point in the
// app's lifecycle where it's safe to replace the file wholesale, since no
// connection is holding it open yet. Any leftover WAL/SHM sidecar files
// from the database being replaced are dropped too, since they belong to
// that old file's transaction log and have no business being replayed
// against the database just swapped in.
const RESTORE_PENDING_PATH = `${DB_PATH}.restore-pending`;
if (fs.existsSync(RESTORE_PENDING_PATH)) {
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.renameSync(RESTORE_PENDING_PATH, DB_PATH);
  console.log('Restored the database from a staged backup.');
}

const db = new DatabaseSync(DB_PATH);
db.DB_PATH = DB_PATH; // exposed for utils/backup.js - see there for why
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a column
// added to schema.sql after someone already has a database needs its own
// migration here.
const memberColumns = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
if (!memberColumns.includes('notes')) {
  db.exec('ALTER TABLE members ADD COLUMN notes TEXT');
}
const newMemberColumns = {
  member_type: "TEXT NOT NULL DEFAULT 'student'",
  address: 'TEXT',
  city: 'TEXT',
  state: 'TEXT',
  zip: 'TEXT',
  phone: 'TEXT',
  email: 'TEXT',
  photo_path: 'TEXT',
  birthday: 'TEXT',
  grade_level: 'TEXT',
  medical_notes: 'TEXT',
  family_id: 'INTEGER',
};
for (const [column, definition] of Object.entries(newMemberColumns)) {
  if (!memberColumns.includes(column)) {
    db.exec(`ALTER TABLE members ADD COLUMN ${column} ${definition}`);
  }
}

// One-time migration: the old asymmetric "primary parent_id + additional
// parents in member_parents" model is replaced by a single symmetric
// family_id grouping. Anyone who already has a database with the old
// columns/table gets their existing links folded into family groups
// before those old structures are dropped; a fresh install never sees
// either since schema.sql no longer defines them.
const memberParentsTableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='member_parents'").get();
if (memberColumns.includes('parent_id') || memberParentsTableExists) {
  const links = [];
  if (memberColumns.includes('parent_id')) {
    db.prepare('SELECT id, parent_id FROM members WHERE parent_id IS NOT NULL')
      .all()
      .forEach((r) => links.push([r.id, r.parent_id]));
  }
  if (memberParentsTableExists) {
    db.prepare('SELECT student_id, parent_id FROM member_parents')
      .all()
      .forEach((r) => links.push([r.student_id, r.parent_id]));
  }

  // Union-find over every linked pair, so a student linked to two parents
  // (or two students sharing a parent) end up in one shared group.
  const parentOf = new Map();
  function find(x) {
    if (!parentOf.has(x)) parentOf.set(x, x);
    let root = x;
    while (parentOf.get(root) !== root) root = parentOf.get(root);
    while (parentOf.get(x) !== root) {
      const next = parentOf.get(x);
      parentOf.set(x, root);
      x = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parentOf.set(ra, rb);
  }
  links.forEach(([a, b]) => union(a, b));

  const groups = new Map(); // root -> [memberIds]
  for (const id of parentOf.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  let nextFamilyId = 1;
  const assignFamily = db.prepare('UPDATE members SET family_id = ? WHERE id = ?');
  for (const memberIds of groups.values()) {
    if (memberIds.length < 2) continue;
    const familyId = nextFamilyId++;
    for (const id of memberIds) assignFamily.run(familyId, id);
  }

  if (memberColumns.includes('parent_id')) db.exec('ALTER TABLE members DROP COLUMN parent_id');
  if (memberParentsTableExists) db.exec('DROP TABLE member_parents');
}

// The Admin member type (co-op staff/leaders as a Membership Form profile
// type) has been removed - Members are only Student or Parent now. Anyone
// who already has member_type = 'admin' is folded into Parent, the closest
// equivalent (an adult, not checked in/out), rather than left on a value
// nothing in the app can create or edit into anymore. This is separate
// from the site's own Admin login (the `admins` table) - unaffected.
db.exec("UPDATE members SET member_type = 'parent' WHERE member_type = 'admin'");

// One-time migration: family_id used to be an arbitrary grouping number
// with no name attached anywhere. It's now a real FK into the new
// `families` table (a family the admin names via "+ Add Family" before
// picking it on a member's profile). Anyone who already has family_id
// groupings gets a families row invented for each one (named after the
// group's primary parent, or its first member, surname) so their existing
// groupings survive the switch instead of being silently dropped. A fresh
// install has no family_id values set yet, so this is a no-op for it.
if (db.prepare('SELECT COUNT(*) AS c FROM families').get().c === 0) {
  const legacyFamilyIds = db
    .prepare('SELECT DISTINCT family_id FROM members WHERE family_id IS NOT NULL')
    .all()
    .map((r) => r.family_id);
  const insertFamily = db.prepare('INSERT INTO families (name) VALUES (?)');
  const familyNameTaken = db.prepare('SELECT id FROM families WHERE name = ? COLLATE NOCASE');
  for (const legacyId of legacyFamilyIds) {
    // Snapshot this group's member ids up front - reassigning family_id
    // below (to a brand-new families.id) never risks re-matching a
    // still-unprocessed legacy id's own WHERE clause, since every update
    // targets these specific ids rather than a family_id value.
    const groupMembers = db.prepare('SELECT id, name, is_primary_parent FROM members WHERE family_id = ?').all(legacyId);
    if (groupMembers.length === 0) continue;
    const primary = groupMembers.find((m) => m.is_primary_parent) || groupMembers[0];
    const lastName = primary.name.trim().split(/\s+/).pop() || 'Family';
    let name = lastName;
    let suffix = 1;
    while (familyNameTaken.get(name)) {
      suffix++;
      name = `${lastName} ${suffix}`;
    }
    const newFamilyId = insertFamily.run(name).lastInsertRowid;
    const ids = groupMembers.map((m) => m.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE members SET family_id = ? WHERE id IN (${placeholders})`).run(newFamilyId, ...ids);
  }
}

const rosterMemberColumns = db.prepare('PRAGMA table_info(roster_members)').all().map((c) => c.name);
if (!rosterMemberColumns.includes('scheduled_arrival')) {
  db.exec('ALTER TABLE roster_members ADD COLUMN scheduled_arrival TEXT');
}
if (!rosterMemberColumns.includes('scheduled_departure')) {
  db.exec('ALTER TABLE roster_members ADD COLUMN scheduled_departure TEXT');
}
if (!rosterMemberColumns.includes('source')) {
  db.exec("ALTER TABLE roster_members ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'");
}

const nameTagRequestColumns = db.prepare('PRAGMA table_info(name_tag_requests)').all().map((c) => c.name);
if (!nameTagRequestColumns.includes('archived')) {
  db.exec('ALTER TABLE name_tag_requests ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}

const rosterColumns = db.prepare('PRAGMA table_info(rosters)').all().map((c) => c.name);
if (!rosterColumns.includes('schedule_day')) {
  db.exec('ALTER TABLE rosters ADD COLUMN schedule_day TEXT');
}

// volunteer_members used to key on (list, member) alone - one section per
// member. It now keys on (list, member, section) so a member can be on
// multiple hours. SQLite can't ALTER a primary key, so rebuild the table
// in place for anyone who already has the old shape.
const volunteerMemberColumns = db.prepare('PRAGMA table_info(volunteer_members)').all();
const hasNewVolunteerMembersPk = volunteerMemberColumns.some((c) => c.name === 'section_id' && c.pk > 0);
if (volunteerMemberColumns.length > 0 && !hasNewVolunteerMembersPk) {
  db.exec(`
    ALTER TABLE volunteer_members RENAME TO volunteer_members_old;
    CREATE TABLE volunteer_members (
      volunteer_list_id INTEGER NOT NULL REFERENCES volunteer_lists(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      section_id INTEGER NOT NULL REFERENCES volunteer_sections(id) ON DELETE CASCADE,
      PRIMARY KEY (volunteer_list_id, member_id, section_id)
    );
    INSERT INTO volunteer_members (volunteer_list_id, member_id, section_id)
      SELECT volunteer_list_id, member_id, section_id FROM volunteer_members_old;
    DROP TABLE volunteer_members_old;
  `);
}

const volunteerMemberColumns2 = db.prepare('PRAGMA table_info(volunteer_members)').all().map((c) => c.name);
if (!volunteerMemberColumns2.includes('rank')) {
  db.exec("ALTER TABLE volunteer_members ADD COLUMN rank TEXT NOT NULL DEFAULT 'sometimes'");
}

const substituteAssignmentColumns = db.prepare('PRAGMA table_info(substitute_assignments)').all().map((c) => c.name);
if (!substituteAssignmentColumns.includes('status')) {
  db.exec("ALTER TABLE substitute_assignments ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
}

const memberPortalColumns = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
if (!memberPortalColumns.includes('username')) {
  db.exec('ALTER TABLE members ADD COLUMN username TEXT UNIQUE');
}
if (!memberPortalColumns.includes('password_hash')) {
  db.exec('ALTER TABLE members ADD COLUMN password_hash TEXT');
}
for (const column of ['portal_parent', 'portal_student', 'portal_coop_admin']) {
  if (!memberPortalColumns.includes(column)) {
    db.exec(`ALTER TABLE members ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}
if (!memberPortalColumns.includes('is_primary_parent')) {
  db.exec('ALTER TABLE members ADD COLUMN is_primary_parent INTEGER NOT NULL DEFAULT 0');
}

const classColumns = db.prepare('PRAGMA table_info(classes)').all().map((c) => c.name);
if (!classColumns.includes('roster_id')) {
  db.exec('ALTER TABLE classes ADD COLUMN roster_id INTEGER REFERENCES rosters(id) ON DELETE SET NULL');
}
if (!classColumns.includes('start_time')) {
  db.exec('ALTER TABLE classes ADD COLUMN start_time TEXT');
}
if (!classColumns.includes('end_time')) {
  db.exec('ALTER TABLE classes ADD COLUMN end_time TEXT');
}

const permanentJobColumns = db.prepare('PRAGMA table_info(permanent_jobs)').all().map((c) => c.name);
if (!permanentJobColumns.includes('room')) {
  db.exec('ALTER TABLE permanent_jobs ADD COLUMN room TEXT');
}

const setupTeamColumns = db.prepare('PRAGMA table_info(setup_teams)').all().map((c) => c.name);
if (!setupTeamColumns.includes('leader_id')) {
  db.exec('ALTER TABLE setup_teams ADD COLUMN leader_id INTEGER REFERENCES members(id) ON DELETE SET NULL');
}

const libraryItemColumns = db.prepare('PRAGMA table_info(library_items)').all().map((c) => c.name);
if (!libraryItemColumns.includes('type')) {
  db.exec('ALTER TABLE library_items ADD COLUMN type TEXT');
}

const libraryCheckoutColumns = db.prepare('PRAGMA table_info(library_checkouts)').all().map((c) => c.name);
if (!libraryCheckoutColumns.includes('due_date')) {
  db.exec('ALTER TABLE library_checkouts ADD COLUMN due_date TEXT');
}

// Seed a default admin account on first run so the dashboard is reachable.
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
if (adminCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Seeded default admin account "${username}". Change the password after first login.`);
}

// Seed a default Class Check-In PIN the same way - one shared 4-digit PIN
// any staff member uses at the kiosk's Class Check-In flow (see
// routes/kiosk-class-checkin.js), stored hashed in app_settings like
// everything else there, changeable afterward via Settings > Class
// Check-In PIN (routes/admin.js). Not tied to any one admin account -
// there's exactly one PIN for the whole app, same as there's exactly one
// admin login.
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'class_checkin_pin_hash'").get()) {
  const pin = process.env.CLASS_CHECKIN_PIN || '0000';
  const pinHash = bcrypt.hashSync(pin, 10);
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('class_checkin_pin_hash', pinHash);
  console.log(`Seeded default Class Check-In PIN "${pin}". Change it under Settings after first login.`);
}

// Seed the two fixed volunteer lists (Monday/Wednesday) with 4 default
// hour sections each, so the Volunteers admin page always has both to show.
for (const day of ['monday', 'wednesday']) {
  const existing = db.prepare('SELECT id FROM volunteer_lists WHERE day = ?').get(day);
  if (existing) continue;
  const info = db.prepare('INSERT INTO volunteer_lists (day) VALUES (?)').run(day);
  const listId = info.lastInsertRowid;
  const insertSection = db.prepare('INSERT INTO volunteer_sections (volunteer_list_id, position, label) VALUES (?, ?, ?)');
  for (let i = 1; i <= 4; i++) insertSection.run(listId, i, `Hour ${i}`);
}

// Seed 4 default hour slots for the Class Schedule (Monday/Wednesday),
// same "Hour N" starter labels as the Floater Assignments sections above.
for (const day of ['monday', 'wednesday']) {
  const existing = db.prepare('SELECT id FROM class_schedule_hours WHERE day = ?').get(day);
  if (existing) continue;
  const insertHour = db.prepare('INSERT INTO class_schedule_hours (day, position, label) VALUES (?, ?, ?)');
  for (let i = 1; i <= 4; i++) insertHour.run(day, i, `Hour ${i}`);
}

// Seed a starter badge design for each member type so the design editor
// and badge printing always have something to render.
for (const memberType of ['student', 'parent']) {
  const existing = db.prepare('SELECT member_type FROM name_tag_templates WHERE member_type = ?').get(memberType);
  if (existing) continue;
  db.prepare('INSERT INTO name_tag_templates (member_type, layout_json) VALUES (?, ?)').run(
    memberType,
    JSON.stringify(DEFAULT_LAYOUTS[memberType])
  );
}

// Seed a starter design for each misc badge type (Setup/Cleanup, Custom),
// same pattern as the per-member-type name tag seeding above.
for (const badgeType of ['setupCleanup', 'custom']) {
  const existing = db.prepare('SELECT badge_type FROM misc_badge_templates WHERE badge_type = ?').get(badgeType);
  if (existing) continue;
  db.prepare('INSERT INTO misc_badge_templates (badge_type, layout_json) VALUES (?, ?)').run(
    badgeType,
    JSON.stringify(DEFAULT_LAYOUTS[badgeType])
  );
}

// Seed the single starter Schedule Card design.
const existingScheduleCardTemplate = db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
if (!existingScheduleCardTemplate) {
  db.prepare('INSERT INTO schedule_card_templates (id, layout_json) VALUES (1, ?)').run(
    JSON.stringify(SCHEDULE_CARD_DEFAULT_LAYOUT)
  );
} else {
  // One-time upgrade: earlier default layouts had an "org" title line
  // above the member's name (removed), or a larger un-shrunk name element
  // (fontSize 16, before it was shrunk to leave room at the card's
  // bottom). Anyone still on one of those untouched defaults gets
  // migrated forward to the current default rather than needing to click
  // "Reset to Default" themselves. A layout an admin has actually
  // customized won't match either fingerprint, so it's left alone.
  let layout;
  try {
    layout = JSON.parse(existingScheduleCardTemplate.layout_json);
  } catch (err) {
    layout = null;
  }
  const elements = layout && Array.isArray(layout.elements) ? layout.elements : [];
  const nameEl = elements.find((el) => el.id === 'name');
  const stillOnPriorDefault = elements.some((el) => el.id === 'org') || (nameEl && nameEl.fontSize === 16);

  // Same idea, second fingerprint: the pre-"Primary Parent Phone" default
  // had exactly these 5 elements and no primaryParentPhone field. Anyone
  // still on that gets the new phone line for free too.
  const priorFieldDefaultIds = ['name', 'mon-label', 'mon-table', 'wed-label', 'wed-table'];
  const currentIds = elements.map((el) => el.id).sort();
  const hasPhoneField = elements.some((el) => el.field === 'primaryParentPhone');
  const stillMissingPhoneField =
    !hasPhoneField &&
    currentIds.length === priorFieldDefaultIds.length &&
    priorFieldDefaultIds.slice().sort().every((id, i) => currentIds[i] === id);

  // Third fingerprint: the pre-auto-fit default had the phone stacked in
  // its own centered row below the name (rather than sharing the name's
  // row, right-aligned) and un-shrunk table heights (66/68px, before the
  // freed row let them grow to 82/79px). Anyone still on that exact prior
  // default - name/phone with no autoFitText and the old table heights -
  // gets migrated forward too.
  const monTableEl = elements.find((el) => el.id === 'mon-table');
  const wedTableEl = elements.find((el) => el.id === 'wed-table');
  const stillOnPriorAutoFitDefault =
    nameEl && nameEl.autoFitText !== true && monTableEl && monTableEl.height === 66 && wedTableEl && wedTableEl.height === 68;

  if (stillOnPriorDefault || stillMissingPhoneField || stillOnPriorAutoFitDefault) {
    db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(
      JSON.stringify(SCHEDULE_CARD_DEFAULT_LAYOUT)
    );
  }
}

// One-time backfill: a session date used to only get added to whichever
// single roster tab it was entered from (e.g. "Monday Students"), leaving
// the sibling "Monday Parents" roster without it - so a teaching parent
// reporting their own absence for that date via the public form would be
// told they "aren't on any roster", even though their own kids' roster
// had that exact date. Parents and students at the same session always
// meet on the same calendar dates, so this merges each day's Parent/
// Student roster_dates together. Going forward, routes/admin-rosters.js
// keeps them in sync itself whenever a date is added or removed.
{
  // Scoped to category = 'Class Schedule' - the 4 fixed Monday/Wednesday
  // Parent/Student rosters - NOT 'Class Roster' (each class's own
  // auto-maintained roster, which also carries a schedule_day but has
  // never needed to share dates with anything).
  const scheduleDays = db
    .prepare("SELECT DISTINCT schedule_day FROM rosters WHERE schedule_day IS NOT NULL AND category = 'Class Schedule'")
    .all();
  const insertDate = db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)');
  for (const { schedule_day: day } of scheduleDays) {
    const rosterIds = db
      .prepare("SELECT id FROM rosters WHERE schedule_day = ? AND category = 'Class Schedule'")
      .all(day)
      .map((r) => r.id);
    if (rosterIds.length < 2) continue;
    const placeholders = rosterIds.map(() => '?').join(',');
    const allDates = db
      .prepare(`SELECT DISTINCT session_date FROM roster_dates WHERE roster_id IN (${placeholders})`)
      .all(...rosterIds)
      .map((r) => r.session_date);
    for (const rosterId of rosterIds) {
      for (const date of allDates) insertDate.run(rosterId, date);
    }
  }
}

// Seed the starter leadership roles for Contact Admins - name/email left
// blank for a full Admin to fill in via Settings, rather than inventing
// fake contacts.
const leadershipCount = db.prepare('SELECT COUNT(*) AS c FROM leadership_contacts').get().c;
if (leadershipCount === 0) {
  const insertRole = db.prepare('INSERT INTO leadership_contacts (role, position) VALUES (?, ?)');
  ['Director', 'Assistant Director', 'Co-op Classes', 'Finance Team', 'Events Coordinator', 'Yearbook Team'].forEach(
    (role, i) => insertRole.run(role, i)
  );
}

// Runs fn() inside an explicit transaction, rolling back on any throw. Most
// multi-statement writes elsewhere in the app run as several independent,
// unwrapped statements - fine for a single interleaved request (node:sqlite
// is synchronous and Node is single-threaded, so one request's statements
// always finish before the next request's can start - see the app's own
// audit notes on why that rules out classic interleaved-request races) but
// not safe against the process dying between two statements (a kiosk
// machine losing power mid-request is not hypothetical for this
// deployment). Anywhere removing a date/member/record touches more than
// one table that has to stay consistent with each other should use this
// instead of running bare statements in a row - see routes/admin-rosters.js's
// archiveDay() for the original hand-written version this generalizes.
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
db.withTransaction = withTransaction;

module.exports = db;
