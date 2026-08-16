// First-boot seeding for a fresh Postgres database - the Postgres
// equivalent of the "Seed a ..." blocks in db/index.js (the SQLite
// version), NOT its "One-time backfill/upgrade" blocks. Those upgrade
// blocks exist only to bring an already-deployed SQLite database that
// predates some feature up to date; a brand new Postgres database created
// from supabase/migrations/*.sql has no pre-existing rows to upgrade in
// the first place, so none of them apply here - see MIGRATION.md.
//
// Schema itself is NOT applied here for a real Supabase/Postgres
// connection - that's the Supabase CLI's job (`supabase db push` /
// migrations), run once per environment, not on every app boot the way
// SQLite's schema.sql is. For the pglite test database, which has no
// separate migration step, the caller (test/pgTestDb.js) applies the
// schema file directly before calling this.
const bcrypt = require('bcryptjs');
const { DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { DEFAULT_LAYOUT: SCHEDULE_CARD_DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');

async function seedIfMissing(db) {
  const adminCount = (await db.prepare('SELECT COUNT(*) AS c FROM admins').get()).c;
  if (Number(adminCount) === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(password, 10);
    await db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`Seeded default admin account "${username}". Change the password after first login.`);
  }

  if (!(await db.prepare("SELECT 1 FROM app_settings WHERE key = 'class_checkin_pin_hash'").get())) {
    const pin = process.env.CLASS_CHECKIN_PIN || '0000';
    const pinHash = bcrypt.hashSync(pin, 10);
    await db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('class_checkin_pin_hash', pinHash);
    console.log(`Seeded default Class Check-In PIN "${pin}". Change it under Settings after first login.`);
  }

  for (const day of ['monday', 'wednesday']) {
    const existing = await db.prepare('SELECT id FROM volunteer_lists WHERE day = ?').get(day);
    if (existing) continue;
    const info = await db.prepare('INSERT INTO volunteer_lists (day) VALUES (?)').run(day);
    const listId = info.lastInsertRowid;
    for (let i = 1; i <= 4; i++) {
      await db.prepare('INSERT INTO volunteer_sections (volunteer_list_id, position, label) VALUES (?, ?, ?)').run(listId, i, `Hour ${i}`);
    }
  }

  for (const day of ['monday', 'wednesday']) {
    const existing = await db.prepare('SELECT id FROM class_schedule_hours WHERE day = ?').get(day);
    if (existing) continue;
    for (let i = 1; i <= 4; i++) {
      await db.prepare('INSERT INTO class_schedule_hours (day, position, label) VALUES (?, ?, ?)').run(day, i, `Hour ${i}`);
    }
  }

  for (const memberType of ['student', 'parent']) {
    const existing = await db.prepare('SELECT member_type FROM name_tag_templates WHERE member_type = ?').get(memberType);
    if (existing) continue;
    await db
      .prepare('INSERT INTO name_tag_templates (member_type, layout_json) VALUES (?, ?)')
      .run(memberType, JSON.stringify(DEFAULT_LAYOUTS[memberType]));
  }

  for (const badgeType of ['setupCleanup', 'custom']) {
    const existing = await db.prepare('SELECT badge_type FROM misc_badge_templates WHERE badge_type = ?').get(badgeType);
    if (existing) continue;
    await db
      .prepare('INSERT INTO misc_badge_templates (badge_type, layout_json) VALUES (?, ?)')
      .run(badgeType, JSON.stringify(DEFAULT_LAYOUTS[badgeType]));
  }

  const existingScheduleCardTemplate = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  if (!existingScheduleCardTemplate) {
    await db
      .prepare('INSERT INTO schedule_card_templates (id, layout_json) VALUES (1, ?)')
      .run(JSON.stringify(SCHEDULE_CARD_DEFAULT_LAYOUT));
  }

  const leadershipCount = (await db.prepare('SELECT COUNT(*) AS c FROM leadership_contacts').get()).c;
  if (Number(leadershipCount) === 0) {
    const roles = ['Director', 'Assistant Director', 'Co-op Classes', 'Finance Team', 'Events Coordinator', 'Yearbook Team'];
    for (let i = 0; i < roles.length; i++) {
      await db.prepare('INSERT INTO leadership_contacts (role, position) VALUES (?, ?)').run(roles[i], i);
    }
  }
}

// Genuine one-time backfill for an ALREADY-DEPLOYED Postgres database -
// unlike seedIfMissing above (fresh-install-only, see this file's own
// header comment), this has to run against a name_tag_templates row that
// already exists, because seedIfMissing only ever inserts that row once,
// the first time the app boots against a brand new database. An install
// that had already seeded its student/parent template before the "logo"
// element was added to DEFAULT_LAYOUTS (utils/nameTagBadge.js) would
// otherwise never pick the logo up on its own - the saved row simply
// isn't touched again after that first insert.
// Only replaces a saved layout wholesale when it still has exactly the
// pre-logo default's own element ids (nobody has customized it in the
// editor yet) - safe to swap in the fully-repositioned new default there.
// Otherwise, so a real admin-customized layout is never silently
// overwritten, this only adds a small logo image element in a free
// corner, leaving every existing element exactly where it is.
const PRE_LOGO_ELEMENT_IDS = {
  student: ['memberCode', 'name', 'grade', 'barcode'],
  parent: ['memberCode', 'name', 'team', 'barcode'],
};

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

async function backfillNameTagLogo(db) {
  for (const memberType of Object.keys(PRE_LOGO_ELEMENT_IDS)) {
    const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get(memberType);
    if (!row) continue;
    let parsed;
    try {
      parsed = JSON.parse(row.layout_json);
    } catch (err) {
      continue;
    }
    const layout = Array.isArray(parsed) ? { background: '#ffffff', backgroundOpacity: 1, elements: parsed } : parsed;
    if (!layout.elements || layout.elements.some((el) => el.type === 'image')) continue;

    const newLayout = sameIds(layout.elements.map((el) => el.id), PRE_LOGO_ELEMENT_IDS[memberType])
      ? DEFAULT_LAYOUTS[memberType]
      : {
          ...layout,
          elements: [{ id: 'logo', type: 'image', src: '/img/logo-owl.png', x: 288, y: 4, width: 32, height: 32 }, ...layout.elements],
        };

    await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify(newLayout), memberType);
  }
}

module.exports = { seedIfMissing, backfillNameTagLogo };
