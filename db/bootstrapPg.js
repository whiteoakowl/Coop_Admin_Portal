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

// A saved badge/schedule-card layout can predate the { background,
// elements } wrapper - old rows stored a bare elements array instead (see
// utils/nameTagData.js's getTemplate, which already has to unwrap this
// same legacy shape on every read). Every backfill below needs this too:
// checking `layout.elements` against a still-bare array would find
// `undefined` (arrays have no .elements property) and silently skip the
// row forever, exactly the "never went into effect" failure mode this
// whole file exists to avoid.
function normalizeLayout(parsed) {
  return Array.isArray(parsed) ? { background: '#ffffff', backgroundOpacity: 1, elements: parsed } : parsed;
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
    const layout = normalizeLayout(parsed);
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

// Genuine one-time backfill for an already-deployed database's EXISTING
// name_tag_templates rows, saved before autoFitText existed on the name
// field (see public/js/name-tag-render-core.js's fitFontSize) - a real
// bug report: a customized template (one that took backfillNameTagLogo's
// "leave everything else as-is" branch above, so it never picked up the
// flag from a fresh DEFAULT_LAYOUTS swap either) kept clipping a longer
// name ("Carson Bell") instead of shrinking it to fit, on both the design
// editor and the actual printed tag, since both render through the same
// shared core. Every OTHER text field (grade, allergies, cleanup team,
// custom text, ...) is left exactly as saved - shrink-to-fit only ever
// made sense as the default for the one field every name tag actually
// needs to stay legible regardless of how long a person's name is.
async function backfillNameTagAutoFit(db) {
  const rows = await db.prepare('SELECT member_type, layout_json FROM name_tag_templates').all();
  for (const row of rows) {
    let layout;
    try {
      layout = normalizeLayout(JSON.parse(row.layout_json));
    } catch (err) {
      continue;
    }
    if (!layout || !Array.isArray(layout.elements)) continue;

    let changed = false;
    const elements = layout.elements.map((el) => {
      if (el.type === 'text' && el.field === 'name' && !el.autoFitText) {
        changed = true;
        return { ...el, autoFitText: true };
      }
      return el;
    });
    if (!changed) continue;

    await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify({ ...layout, elements }), row.member_type);
  }
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// misc_badge_templates 'setupCleanup' row - seedIfMissing (above) only
// ever inserts that row once, the first time the app boots against a
// brand new database, so an install whose row was already seeded before
// the barcode element was added to DEFAULT_LAYOUTS.setupCleanup (utils/
// nameTagBadge.js - lets a parent scan the physical badge at checkout,
// see routes/checkout.js's task-scan step) never picks it up on its own.
// A real bug report: the barcode simply never appeared on a Setup/
// Cleanup badge's design preview OR its printed card, because both
// render the same saved template (routes/admin-misc-badges.js's print
// route, and the Design tab's own preview). Only adds a barcode element
// when the saved layout has none at all, leaving every other
// customization untouched - 'custom' is deliberately excluded, since its
// own default has no barcode element and isn't meant to be scanned (see
// utils/miscBadgeData.js's own miscBadgeRowData comment).
async function backfillMiscBadgeBarcode(db) {
  const row = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (layout.elements.some((el) => el.type === 'barcode')) return;

  const barcodeDefault = DEFAULT_LAYOUTS.setupCleanup.elements.find((el) => el.type === 'barcode');
  if (!barcodeDefault) return;
  const elements = [...layout.elements, { ...barcodeDefault }];

  await db.prepare("UPDATE misc_badge_templates SET layout_json = ? WHERE badge_type = 'setupCleanup'").run(JSON.stringify({ ...layout, elements }));
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// schedule_card_templates row (id=1) - seedIfMissing only ever inserts
// this row once, the first time the app boots against a brand new
// database, so an install whose row was already seeded before "remove
// name and add allergies" landed (utils/scheduleCardBadge.js's own
// DEFAULT_LAYOUT comment) never picked that redesign up - the saved row
// simply isn't touched again after that first insert. A real bug report:
// a production Schedule Card kept showing the member's name with no
// allergy anywhere on it. Removes any leftover "name"-field element (the
// current default no longer has one) and inserts the current default's
// own allergy element, only when the saved layout doesn't already have
// one - safe to run even against a layout with other real customizations
// (tables moved, phone line restyled, ...), since only the name/allergy
// elements themselves are touched.
async function backfillScheduleCardAllergy(db) {
  const row = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (layout.elements.some((el) => el.field === 'allergy')) return;

  const allergyDefault = SCHEDULE_CARD_DEFAULT_LAYOUT.elements.find((el) => el.field === 'allergy');
  if (!allergyDefault) return;
  const elements = [{ ...allergyDefault }, ...layout.elements.filter((el) => el.field !== 'name')];

  await db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(JSON.stringify({ ...layout, elements }));
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// 'parent' name_tag_templates row, saved before the Monday/Wednesday
// setup/cleanup job fields existed (utils/nameTagData.js's
// setupCleanupJobLabels) - seedIfMissing only ever inserts a member type's
// row once, so an install whose parent template was already saved (even
// the untouched fresh default, before this feature shipped) never picks
// the new elements up on its own. A real request: those two lines need to
// be the first thing on a parent's badge - prepended to whatever the
// saved layout already has (front of the array is front of the badge,
// since element order is stacking/paint order - see name-tag-render-
// core.js's own comment) rather than appended at the end, so this lands
// them there even for a heavily customized layout, not just a still-
// default one. Only adds them when the saved layout has neither field at
// all, leaving every other customization (including someone who
// deliberately removed the old cleanupTeam field) untouched.
async function backfillParentSetupCleanupDays(db) {
  const row = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (layout.elements.some((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup')) return;

  const newDefaults = DEFAULT_LAYOUTS.parent.elements.filter((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup');
  const elements = [...newDefaults.map((el) => ({ ...el })), ...layout.elements];

  await db.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify({ ...layout, elements }));
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// task_list_items rows, created before the barcode column existed -
// nothing else ever revisits an old row once it's inserted (utils/
// taskList.js's addItem only assigns a barcode to a NEW row), so without
// this an already-live co-op's existing task list would keep every one
// of its tasks permanently un-scannable. Also creates each backfilled
// task's own Setup/Cleanup badge (see misc_badges.task_item_id's own
// schema comment) - a task created before this feature shipped has no
// badge row at all yet, same as a fresh one only gets one via
// upsertTaskBadge at creation time.
async function backfillTaskItemBarcodes(db) {
  const rows = await db.prepare('SELECT id, description, section_id FROM task_list_items WHERE barcode IS NULL').all();
  if (rows.length === 0) return;
  const existsCode = db.prepare('SELECT 1 FROM task_list_items WHERE barcode = ?');
  for (const row of rows) {
    let code;
    do {
      code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    } while (await existsCode.get(code));
    await db.prepare('UPDATE task_list_items SET barcode = ? WHERE id = ?').run(code, row.id);

    const section = await db.prepare('SELECT title FROM task_list_sections WHERE id = ?').get(row.section_id);
    const existingBadge = await db.prepare('SELECT id FROM misc_badges WHERE task_item_id = ?').get(row.id);
    if (existingBadge) continue;
    await db
      .prepare('INSERT INTO misc_badges (badge_type, badge_number, title, description, barcode, task_item_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('setupCleanup', code, row.description, section ? section.title : null, code, row.id);
  }
}

module.exports = {
  seedIfMissing,
  backfillNameTagLogo,
  backfillNameTagAutoFit,
  backfillMiscBadgeBarcode,
  backfillScheduleCardAllergy,
  backfillParentSetupCleanupDays,
  backfillTaskItemBarcodes,
};
