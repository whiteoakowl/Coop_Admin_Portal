const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { DEFAULT_LAYOUT: SCHEDULE_CARD_DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'attendance.db');
const db = new DatabaseSync(DB_PATH);
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

const rosterMemberColumns = db.prepare('PRAGMA table_info(roster_members)').all().map((c) => c.name);
if (!rosterMemberColumns.includes('scheduled_arrival')) {
  db.exec('ALTER TABLE roster_members ADD COLUMN scheduled_arrival TEXT');
}
if (!rosterMemberColumns.includes('scheduled_departure')) {
  db.exec('ALTER TABLE roster_members ADD COLUMN scheduled_departure TEXT');
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

// Seed a default admin account on first run so the dashboard is reachable.
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
if (adminCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Seeded default admin account "${username}". Change the password after first login.`);
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
for (const memberType of ['student', 'parent', 'admin']) {
  const existing = db.prepare('SELECT member_type FROM name_tag_templates WHERE member_type = ?').get(memberType);
  if (existing) continue;
  db.prepare('INSERT INTO name_tag_templates (member_type, layout_json) VALUES (?, ?)').run(
    memberType,
    JSON.stringify(DEFAULT_LAYOUTS[memberType])
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
  if (stillOnPriorDefault) {
    db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(
      JSON.stringify(SCHEDULE_CARD_DEFAULT_LAYOUT)
    );
  }
}

module.exports = db;
