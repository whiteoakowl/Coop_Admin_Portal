const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

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

module.exports = db;
