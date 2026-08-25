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

  for (const memberType of ['student', 'parent', 'admin']) {
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

  // A real request: "make an admin setup/cleanup card with a barcode. if
  // someone doesn't have a setup cleanup card to scan the admin setup/
  // cleanup card can be scanned to bypass the checkout demand for a
  // setup/cleanup card... this card isn't linked to any specific member.
  // its just a general bypass card." A real 'setupCleanup' misc_badges
  // row (see routes/checkout.js's findSetupCleanupBypassBadge use of it)
  // but with task_item_id left NULL - every other row of that badge_type
  // is auto-created 1:1 from a real task_list_items row (utils/
  // taskList.js's upsertTaskBadge), so a NULL task_item_id row is never
  // produced any other way and safely doubles as this row's own marker.
  // Seeded once, like the default admin account/PIN above - not part of
  // the admin-imported/task-derived deck lifecycle (replaceMiscBadges is
  // blocked for 'setupCleanup' server-side - see routes/admin-misc-
  // badges.js), so nothing else ever recreates or touches it once it
  // exists. Shows up in Design > Print > Setup/Cleanup Badges for free,
  // right alongside every real task's own badge.
  const bypassBadgeExists = await db.prepare("SELECT 1 FROM misc_badges WHERE badge_type = 'setupCleanup' AND task_item_id IS NULL").get();
  if (!bypassBadgeExists) {
    const existsCode = db.prepare('SELECT 1 FROM task_list_items WHERE barcode = ?');
    let code;
    do {
      code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    } while (await existsCode.get(code));
    await db
      .prepare('INSERT INTO misc_badges (badge_type, title, description, barcode) VALUES (?, ?, ?, ?)')
      .run(
        'setupCleanup',
        'Setup/Cleanup Bypass Card',
        "Scan this instead of a member's own Setup/Cleanup badge at checkout when they don't have theirs to scan. Not tied to any specific member or task.",
        code
      );
    console.log('Seeded a general Setup/Cleanup bypass badge for checkout (Design > Print > Setup/Cleanup Badges).');
  }

  const leadershipCount = (await db.prepare('SELECT COUNT(*) AS c FROM leadership_contacts').get()).c;
  if (Number(leadershipCount) === 0) {
    const roles = ['Director', 'Assistant Director', 'Co-op Classes', 'Finance Team', 'Events Coordinator', 'Yearbook Team'];
    for (let i = 0; i < roles.length; i++) {
      await db.prepare('INSERT INTO leadership_contacts (role, position) VALUES (?, ?)').run(roles[i], i);
    }
  }

  await seedPortalPlatform(db);
}

// The five starter portal roles, the permission catalog Main Admin can
// grant to any role, and one bootstrapped Main Admin account - without
// this, nobody could ever reach the Main Admin Portal to grant that role
// to anyone else in the first place. Same "seed once on a fresh database"
// pattern as the rest of seedIfMissing above, not a repeatable backfill.
const PORTAL_ROLES = [
  { key: 'parent', label: 'Parent', description: 'Manages their family, registers students for classes, and tracks accounting/training.', isSystem: true },
  { key: 'student', label: 'Student', description: "Views their own classes, assignments, grades, and training.", isSystem: true },
  { key: 'teacher', label: 'Teacher', description: 'Manages their own classes: rosters, attendance, lessons, and grading.', isSystem: true },
  { key: 'coop_admin', label: 'Co-op Admin', description: 'Operational co-op admin: check-in/out, scheduling, floaters, setup/cleanup.', isSystem: true },
  { key: 'main_admin', label: 'Main Admin', description: 'Platform control center: users, roles, website content, and every other portal.', isSystem: true },
];

const PORTAL_PERMISSIONS = [
  { key: 'manage_users', label: 'Manage Users', description: 'Approve accounts, assign roles and portal access.' },
  { key: 'manage_roles', label: 'Manage Roles & Permissions', description: 'Create/edit roles and control which permissions they grant.' },
  { key: 'manage_website', label: 'Manage Website', description: 'Edit the public homepage, announcements, and FAQs.' },
  { key: 'manage_classes', label: 'Manage Classes', description: 'Create/edit classes, capacity, and registration windows.' },
  { key: 'manage_registrations', label: 'Manage Registrations', description: "Review and adjust members' class registrations." },
  { key: 'manage_events', label: 'Manage Events', description: 'Create/edit events, volunteer signups, and donation requests.' },
  { key: 'manage_volunteers', label: 'Manage Volunteers', description: 'Manage floater/setup-cleanup assignments and event volunteer signups.' },
  { key: 'manage_classifieds', label: 'Manage Classifieds', description: 'Approve, archive, and moderate classifieds listings.' },
  { key: 'manage_finances', label: 'Manage Finances', description: 'View and record accounting charges, payments, and refunds.' },
  { key: 'manage_store', label: 'Manage Store', description: 'Manage products, inventory, and orders.' },
  { key: 'manage_forum', label: 'Manage Forum', description: 'Moderate forum categories, threads, and posts.' },
  { key: 'manage_forms', label: 'Manage Forms', description: 'Build and publish custom forms, and view submissions.' },
  { key: 'manage_training', label: 'Manage Training', description: 'Create courses/lessons and assign training.' },
  { key: 'manage_documents', label: 'Manage Documents', description: 'Upload and organize shared documents.' },
  { key: 'manage_publications', label: 'Manage Publications', description: 'Write and publish articles, publications, and photo albums.' },
  { key: 'manage_directory', label: 'Manage Directory', description: 'Manage the member and business directories.' },
  { key: 'manage_communications', label: 'Manage Communications', description: 'Assemble/send the weekly newsletter and control SMS/notification settings.' },
  { key: 'view_audit_log', label: 'View Audit Log', description: 'View the record of financial changes, moderation, and deletions across the app.' },
];

async function seedPortalPlatform(db) {
  const roleIdByKey = {};
  for (const role of PORTAL_ROLES) {
    const existing = await db.prepare('SELECT id FROM roles WHERE key = ?').get(role.key);
    if (existing) {
      roleIdByKey[role.key] = existing.id;
      continue;
    }
    const info = await db
      .prepare('INSERT INTO roles (key, label, description, is_system) VALUES (?, ?, ?, ?)')
      .run(role.key, role.label, role.description, role.isSystem ? 1 : 0);
    roleIdByKey[role.key] = info.lastInsertRowid;
  }

  const permissionIdByKey = {};
  for (const perm of PORTAL_PERMISSIONS) {
    const existing = await db.prepare('SELECT id FROM permissions WHERE key = ?').get(perm.key);
    if (existing) {
      permissionIdByKey[perm.key] = existing.id;
      continue;
    }
    const info = await db.prepare('INSERT INTO permissions (key, label, description) VALUES (?, ?, ?)').run(perm.key, perm.label, perm.description);
    permissionIdByKey[perm.key] = info.lastInsertRowid;
  }

  // Main Admin gets every permission by default - every other role starts
  // with none, left for a Main Admin to grant deliberately from the Roles
  // & Permissions screen.
  const mainAdminRoleId = roleIdByKey.main_admin;
  for (const key of Object.keys(permissionIdByKey)) {
    await db
      .prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?) ON CONFLICT (role_id, permission_id) DO NOTHING')
      .run(mainAdminRoleId, permissionIdByKey[key]);
  }

  const anyMainAdmin = await db
    .prepare('SELECT 1 FROM member_account_roles WHERE role_id = ? LIMIT 1')
    .get(mainAdminRoleId);
  if (anyMainAdmin) return;

  const email = process.env.MAIN_ADMIN_EMAIL || 'mainadmin@coop.local';
  const password = process.env.MAIN_ADMIN_PASSWORD || 'changeme123';

  const existsCode = db.prepare('SELECT 1 FROM members WHERE member_code = ?');
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  } while (await existsCode.get(code));

  // active = 0 - this isn't a real co-op attendee, just the platform's
  // own bootstrap login, so it must stay out of the existing Co-op Admin
  // Portal's own member-facing lists/counts/exports (Members page,
  // rosters, print sheets) by default, the same way every other
  // already-archived member already does.
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Main Admin', ?, ?, 'admin', 0)")
    .run(code, code);
  const passwordHash = bcrypt.hashSync(password, 10);
  const accountInfo = await db
    .prepare(
      "INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())"
    )
    .run(memberInfo.lastInsertRowid, email, passwordHash);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, mainAdminRoleId);

  console.log(`Seeded a Main Admin portal account "${email}" / "${password}". Log in at /login and change the password after first login.`);
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
// shared core. Also covers gradeLevel for the same reason - a real
// follow-up request, since a long grade_level value (utils/nameTagData.js's
// gradeLevelLabel appends "Grade" to every ordinal grade, e.g.
// "Kindergarten" or "12th Grade") can clip exactly the same way an
// unshrunk long name used to. Every OTHER text field (allergies, cleanup
// team, custom text, ...) is left exactly as saved - shrink-to-fit only
// ever made sense as the default for fields whose length genuinely varies
// member to member.
const AUTOFIT_BACKFILL_FIELDS = ['name', 'gradeLevel'];

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
      if (el.type === 'text' && AUTOFIT_BACKFILL_FIELDS.includes(el.field) && !el.autoFitText) {
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
// 'parent' name_tag_templates row, converting the OLD two-separate-
// element Monday/Wednesday setup-cleanup layout (monday-job +
// wednesday-job, added by backfillParentSetupCleanupDays below) into ONE
// shared element bound to setupCleanupDays - a real follow-up request:
// the two lines should "share a text space" rather than sit as two
// disconnected boxes. Only fires when the old fields are present and the
// new merged field isn't yet (so an install already migrated, or one
// where an admin deliberately customized the layout away from either
// shape, is left alone) - replaces just those two elements, in place at
// the position of whichever is found first, leaving every other
// customization (logo position, memberCode styling, ...) untouched. Runs
// after backfillParentSetupCleanupDays in db/index.js's db.ready chain,
// so by the time this fires every parent template already has at least
// the old two-element shape to migrate from (either it always did, or
// that backfill just added it).
async function backfillParentSetupCleanupMerge(db) {
  const row = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (layout.elements.some((el) => el.field === 'setupCleanupDays')) return;

  const oldIndex = layout.elements.findIndex((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup');
  if (oldIndex === -1) return;

  const merged = DEFAULT_LAYOUTS.parent.elements.find((el) => el.field === 'setupCleanupDays');
  if (!merged) return;

  const elements = layout.elements.filter((el) => el.field !== 'mondaySetupCleanup' && el.field !== 'wednesdaySetupCleanup');
  elements.splice(oldIndex, 0, { ...merged });

  await db.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify({ ...layout, elements }));
}

// Genuine one-time (well, repeat-safe - see below) backfill for an
// already-deployed database's EXISTING 'parent' name_tag_templates row -
// a real bug report: a parent's printed badge showed stray, overlapping
// fragments of team/assignment text bleeding onto the name area, even
// though nothing looked wrong in the design editor's own preview. Root
// cause: this originally only matched the OLD default's exact
// { id: 'team', field: 'cleanupTeam' } shape, deliberately leaving alone
// any cleanupTeam element with a different id on the theory that a
// different id could only mean an admin had deliberately re-added it via
// the "Add Element" picker (utils/nameTagBadge.js's FIELDS_BY_TYPE) and
// wanted it there. That theory is what actually broke here: an admin HAD
// re-added it that way at some point (get a normal auto-generated id, not
// "team"), at a position that predates later layout changes (setupCleanup-
// Days moving to the front of the badge, etc.) and now overlaps whatever
// element currently occupies that spot - invisible in the single-badge
// editor preview when a later element in paint order fully covers it
// there, but peeking out from underneath on a real printed badge once
// that covering element's own autofit shrinks smaller for a particular
// member's actual (shorter) text. cleanupTeam's whole ROLE - showing a
// parent's team info on their badge - is now what setupCleanupDays does
// instead, day-by-day and deduplicated ("Monday - Team 1" / "Wednesday -
// Team 2"), so there's no longer a legitimate reason for a cleanupTeam
// element to exist on a parent name tag at all: this now removes EVERY
// element bound to that field, any id, unconditionally, and cleanupTeam
// is dropped from FIELDS_BY_TYPE.parent (below) so "Add Element" can't
// reintroduce it. Runs on every boot (like every backfill here), so it
// also cleans up any future save that somehow reintroduces one.
async function backfillParentRemoveLegacyCleanupTeamElement(db) {
  const row = await db.prepare("SELECT layout_json FROM name_tag_templates WHERE member_type = 'parent'").get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (!layout.elements.some((el) => el.field === 'cleanupTeam')) return;

  const elements = layout.elements.filter((el) => el.field !== 'cleanupTeam');

  await db.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify({ ...layout, elements }));
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
// 'setupCleanup' misc_badge_templates row - a real follow-up request: "the
// description of the tasks, do not reduce the font size to keep it all on
// one line. keep the same font size and simply continue the tasks
// description on the next line below it." DEFAULT_LAYOUTS.setupCleanup's
// own 'task'/description element no longer sets autoFitText (see its own
// comment) so a FRESH install already wraps instead of shrinking, but an
// already-saved template (including a customized one) keeps whatever
// autoFitText value it was saved with - this flips it off wherever found,
// leaving every other customization (position, size, color, font, the
// day/team/leader elements' own autoFitText) untouched.
async function backfillSetupCleanupTaskWraps(db) {
  const row = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (!layout.elements.some((el) => el.field === 'description' && el.autoFitText)) return;

  const elements = layout.elements.map((el) => {
    if (el.field !== 'description' || !el.autoFitText) return el;
    const updated = { ...el };
    delete updated.autoFitText;
    return updated;
  });

  await db.prepare("UPDATE misc_badge_templates SET layout_json = ? WHERE badge_type = 'setupCleanup'").run(JSON.stringify({ ...layout, elements }));
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// misc_badge_templates 'setupCleanup' row - a second, later redesign of
// the same badge. A real bug report, with a screenshot: task text
// overlapping the team name and badge number on the printed card. Fixed
// by dropping the standalone scannable badge_number and the static
// "Setup / Cleanup" org line in favor of day/team name/leader/task, each
// with autoFitText (see DEFAULT_LAYOUTS.setupCleanup's own comment) -
// but that only changes what a BRAND NEW install's row gets seeded with.
// Unlike backfillMiscBadgeBarcode just above (which only ADDS one
// missing element to an otherwise-untouched layout), this replaces the
// WHOLE saved layout - the field set itself changed (day/leaderLabel are
// new; badgeNumber/the static org text are gone), so there's no old
// element positioning left worth preserving once the fields it was
// built around no longer exist on this badge. Detects "still on the old
// shape" by the new day-field element's absence, same as any other
// already-migrated check in this file. 'custom' badges were never part
// of this redesign and are untouched.
async function backfillSetupCleanupBadgeLayout(db) {
  const row = await db.prepare("SELECT layout_json FROM misc_badge_templates WHERE badge_type = 'setupCleanup'").get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;
  if (layout.elements.some((el) => el.field === 'day')) return;

  await db
    .prepare("UPDATE misc_badge_templates SET layout_json = ? WHERE badge_type = 'setupCleanup'")
    .run(JSON.stringify(DEFAULT_LAYOUTS.setupCleanup));
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// misc_badges rows for setupCleanup tasks - the redesign above didn't
// just change the template's layout, it SWAPPED what the underlying
// title/description columns mean for these rows (title: task text ->
// team name, description: section title -> task text - see
// upsertTaskBadge's own comment) and added two genuinely new columns,
// day/leader_name, both NULL on any row inserted before this shipped.
// Anything saved before this redesign is stuck showing the OLD meaning
// in the NEW columns - a "Team Name" field showing task text, a "Task"
// field showing a section title - with day/leader always blank.
// Re-stamps every task item's badge from its section's CURRENT team
// link/title, the same derivation utils/taskList.js's own
// badgeContextForSection makes on every real edit - safe to run every
// boot even once already up to date, since it always re-derives from
// the section/team, never from admin-entered badge data (there isn't
// any for these rows - they're wholly computed, unlike a
// misc_badge_templates layout, which a real admin might hand-customize
// and backfillSetupCleanupBadgeLayout above deliberately only touches
// once). Deliberately reimplements that derivation with raw SQL against
// the `db` PARAMETER, rather than requiring utils/taskList.js and calling
// its exported helpers - those are bound to the app's own global db
// singleton (utils/taskList.js's own `require('../db')`), which is
// exactly what every other test in this suite passes in here as `db`
// EXCEPT the ones creating their own isolated test database
// (test/pgTestDb.js's createTestDb) - calling through to the global
// singleton from inside a function that's supposed to operate on a
// caller-supplied db would silently read/write the wrong database
// there, not this backfill's own target.
async function backfillSetupCleanupBadgeFields(db) {
  const items = await db.prepare('SELECT id, description, section_id, barcode FROM task_list_items').all();
  if (items.length === 0) return;
  const sectionContext = new Map();
  for (const item of items) {
    if (!sectionContext.has(item.section_id)) {
      const section = await db.prepare('SELECT * FROM task_list_sections WHERE id = ?').get(item.section_id);
      let ctx = { day: null, teamName: null, leaderName: null };
      if (section && !section.team_id) {
        ctx = { day: section.day, teamName: section.title, leaderName: null };
      } else if (section) {
        const team = await db
          .prepare(
            `SELECT st.title, st.day, m.name AS "leaderName" FROM setup_teams st
             LEFT JOIN members m ON m.id = st.leader_id AND m.active = 1
             WHERE st.id = ?`
          )
          .get(section.team_id);
        ctx = team ? { day: team.day, teamName: team.title, leaderName: team.leaderName || null } : { day: section.day, teamName: section.title, leaderName: null };
      }
      sectionContext.set(item.section_id, ctx);
    }
    const ctx = sectionContext.get(item.section_id);
    const existing = await db.prepare('SELECT id FROM misc_badges WHERE task_item_id = ?').get(item.id);
    if (existing) {
      await db
        .prepare('UPDATE misc_badges SET title = ?, description = ?, day = ?, leader_name = ? WHERE id = ?')
        .run(ctx.teamName, item.description, ctx.day, ctx.leaderName, existing.id);
      continue;
    }
    await db
      .prepare(
        `INSERT INTO misc_badges (badge_type, badge_number, title, description, day, leader_name, barcode, task_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('setupCleanup', item.barcode, ctx.teamName, item.description, ctx.day, ctx.leaderName, item.barcode, item.id);
  }
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
// schedule_card_templates row, saved before autoFitText existed on its
// allergy/phone fields (utils/scheduleCardBadge.js's own DEFAULT_LAYOUT) -
// same class of bug as backfillNameTagAutoFit above: a row created by
// backfillScheduleCardAllergy itself (or seeded fresh) before that flag
// was added to the default never picks it up again on its own, so a
// longer allergy note ("Peanut, tree nut, and dairy allergy") could clip
// on the printed Schedule Card instead of shrinking to fit. Every OTHER
// element (the day tables, their labels, ...) is left exactly as saved.
const SCHEDULE_CARD_AUTOFIT_FIELDS = ['allergy', 'primaryParentPhone'];

async function backfillScheduleCardAutoFit(db) {
  const row = await db.prepare('SELECT layout_json FROM schedule_card_templates WHERE id = 1').get();
  if (!row) return;
  let layout;
  try {
    layout = normalizeLayout(JSON.parse(row.layout_json));
  } catch (err) {
    return;
  }
  if (!layout || !Array.isArray(layout.elements)) return;

  let changed = false;
  const elements = layout.elements.map((el) => {
    if (el.type === 'text' && SCHEDULE_CARD_AUTOFIT_FIELDS.includes(el.field) && !el.autoFitText) {
      changed = true;
      return { ...el, autoFitText: true };
    }
    return el;
  });
  if (!changed) return;

  await db.prepare('UPDATE schedule_card_templates SET layout_json = ? WHERE id = 1').run(JSON.stringify({ ...layout, elements }));
}

// The split shape this backfill installs - NOT sourced from
// DEFAULT_LAYOUTS.parent, which now holds the later merged setupCleanupDays
// shape instead (see backfillParentSetupCleanupMerge below). Kept as its
// own historical constant so this backfill still does exactly what it did
// when it first shipped, regardless of how the current default has since
// evolved - the merge backfill is what carries a template the rest of the
// way from here to the current shape.
const LEGACY_PARENT_SETUP_CLEANUP_DAY_ELEMENTS = [
  { id: 'monday-job', type: 'text', field: 'mondaySetupCleanup', x: 8, y: 4, width: 320, height: 15, fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle', autoFitText: true },
  { id: 'wednesday-job', type: 'text', field: 'wednesdaySetupCleanup', x: 8, y: 20, width: 320, height: 15, fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle', autoFitText: true },
];

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
// all (nor the later merged setupCleanupDays field either - see
// backfillParentSetupCleanupMerge below; a fresh install seeded straight
// from the current DEFAULT_LAYOUTS.parent has ONLY that merged field, and
// without this check would otherwise look like it "predates the
// feature" and get the old split fields wrongly re-added on top of it),
// leaving every other customization (including someone who deliberately
// removed the old cleanupTeam field) untouched.
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
  if (layout.elements.some((el) => el.field === 'mondaySetupCleanup' || el.field === 'wednesdaySetupCleanup' || el.field === 'setupCleanupDays')) return;

  const elements = [...LEGACY_PARENT_SETUP_CLEANUP_DAY_ELEMENTS.map((el) => ({ ...el })), ...layout.elements];

  await db.prepare("UPDATE name_tag_templates SET layout_json = ? WHERE member_type = 'parent'").run(JSON.stringify({ ...layout, elements }));
}

// Genuine one-time backfill for an already-deployed database's EXISTING
// student/parent name_tag_templates rows - a real request: the name field
// (and, for student, the grade field) should have real room to run a
// bigger font once each was split into 2 stacked lines (utils/
// nameTagData.js's splitNameLines/gradeLevelLabel), not stay pinned at
// the smaller single-line box/font size an older saved template still
// has. Only ever grows height/fontSize UP to at least the current
// DEFAULT_LAYOUTS value for that exact id+field pair, never down - a
// template with a genuinely larger custom size already keeps it, and
// growing a box that was already big enough is a safe no-op (the shared
// height-aware correction in public/js/badge-autofit.js's
// shrinkLinesToFitHeight is the real guarantee against clipping either
// way, this backfill is purely about giving an old install the same
// starting room a fresh install already gets).
const STACKED_SIZING_TARGETS = {
  student: [
    { id: 'name', field: 'name', height: 40, fontSize: 22 },
    { id: 'grade', field: 'gradeLevel', height: 36, fontSize: 16 },
  ],
  parent: [{ id: 'name', field: 'name', height: 40, fontSize: 20 }],
};

async function backfillNameTagStackedSizing(db) {
  for (const memberType of Object.keys(STACKED_SIZING_TARGETS)) {
    const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get(memberType);
    if (!row) continue;
    let layout;
    try {
      layout = normalizeLayout(JSON.parse(row.layout_json));
    } catch (err) {
      continue;
    }
    if (!layout || !Array.isArray(layout.elements)) continue;

    const targets = STACKED_SIZING_TARGETS[memberType];
    let changed = false;
    const elements = layout.elements.map((el) => {
      const target = targets.find((t) => t.id === el.id && t.field === el.field);
      if (!target || el.type !== 'text') return el;
      const height = Math.max(el.height, target.height);
      const fontSize = Math.max(el.fontSize, target.fontSize);
      if (height === el.height && fontSize === el.fontSize) return el;
      changed = true;
      return { ...el, height, fontSize };
    });
    if (!changed) continue;

    await db.prepare('UPDATE name_tag_templates SET layout_json = ? WHERE member_type = ?').run(JSON.stringify({ ...layout, elements }), memberType);
  }
}

// A real request: "can we not update the template so these features of
// wrap text and shrink to fit will always work no matter what we create?"
// - name-tag-render-core.js's renderTextEl now derives autoFitText/
// autoFitWrap for every BOUND field (anything but 'custom'/'description')
// from the field itself, not from a flag stored in the saved layout - so
// a backfill like backfillNameTagAutoFit/backfillAdminPositionAutoFitWrap
// (which briefly existed here, forcing exactly those two flags onto an
// already-saved admin template's position element) is structurally
// unnecessary for this class of bug going forward: there's no longer a
// flag for a saved template to be missing. A genuinely too-small saved
// box can still leave text tiny at the font-shrink floor, which is what
// backfillNameTagStackedSizing above still exists to grow - but the
// "silently clips instead of shrinking" failure mode itself can no longer
// happen no matter what a template does or doesn't have saved.

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
  backfillSetupCleanupTaskWraps,
  backfillSetupCleanupBadgeLayout,
  backfillSetupCleanupBadgeFields,
  backfillScheduleCardAllergy,
  backfillScheduleCardAutoFit,
  backfillParentSetupCleanupDays,
  backfillParentSetupCleanupMerge,
  backfillParentRemoveLegacyCleanupTeamElement,
  backfillNameTagStackedSizing,
  backfillTaskItemBarcodes,
};
