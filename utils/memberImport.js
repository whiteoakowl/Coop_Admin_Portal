// Full-profile member CSV export and spreadsheet import - shared by
// routes/admin-members.js (Co-op Admin) and routes/main-admin-members.js
// (Main Admin). Extracted out of admin-members.js verbatim (same
// behavior, same edge-case fixes already tested there) rather than
// duplicated, since a real request put these same buttons on Main
// Admin's own Members page too: "add member button, edit permissions
// button, edit, import, export buttons should be under the member tab
// above filter."
const db = require('../db');
const { isValidISODate } = require('./dates');
const { generateMemberCode } = require('./members');
const { toCsvRow } = require('./spreadsheet');

const MEMBER_TYPES = ['student', 'parent', 'admin'];

// A genuine Excel/Sheets Date-typed cell (what actually typing a
// birthdate into a spreadsheet produces) comes back through
// utils/spreadsheetWorker.js's raw:false reading as something like
// "4/12/2015" in whatever locale format the sheet used, not the ISO
// "2015-04-12" the birthday column is stored as. Accepts both:
// already-ISO text as-is, or a U.S.-style M/D/Y normalized into ISO. A
// real bug report - "importing birthdays comes in as NaN/NaN/NaN, only
// 1 row imported out of many" - traced to requiring exactly 4 digits;
// \d{2,4} now accepts either, picking 2000s vs 1900s the same way
// spreadsheet apps themselves do for a 2-digit year.
function normalizeBirthdayToISO(value) {
  if (isValidISODate(value)) return value;
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const [, m, d, yRaw] = match;
  const y = yRaw.length === 2 ? (Number(yRaw) < 30 ? `20${yRaw}` : `19${yRaw}`) : yRaw;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidISODate(iso) ? iso : null;
}

const MEMBER_IMPORT_HEADER_ALIASES = {
  firstName: ['first name', 'first'],
  lastName: ['last name', 'last'],
  type: ['type', 'member type'],
  address: ['address'],
  city: ['city'],
  state: ['state'],
  zip: ['zip', 'zip code', 'zipcode'],
  phone: ['phone', 'phone number'],
  email: ['email', 'email address'],
  birthday: ['birthday', 'birth date', 'dob'],
  gradeLevel: ['grade level', 'grade'],
  medicalNotes: ['medical/allergy notes', 'medical notes', 'allergy notes', 'medical'],
  parentFirstName: ['parent first name'],
  parentLastName: ['parent last name'],
};

// First/Last are separate columns in the spreadsheet, but every member is
// still stored as a single "First Last" string - see utils/members.js's
// lastNameOf - the same convention the membership form's one-box Name
// field already uses. Joined back together here at read time so nothing
// downstream (duplicate-name matching, family-name derivation, display)
// needs to know the template ever had separate columns.
function normalizeImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const out = {};
  for (const [field, aliases] of Object.entries(MEMBER_IMPORT_HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (lowerMap[alias] !== undefined && String(lowerMap[alias]).trim() !== '') {
        out[field] = String(lowerMap[alias]).trim();
        break;
      }
    }
  }
  out.name = [out.firstName, out.lastName].filter(Boolean).join(' ');
  out.parentName = [out.parentFirstName, out.parentLastName].filter(Boolean).join(' ');
  return out;
}

// Fields a matched-by-name import row can contribute to an existing
// member's profile - never overwrites a value the member already has,
// only fills in what's currently blank (see mergeableFieldsFor below).
const IMPORT_MERGE_FIELDS = [
  ['address', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'Zip'],
  ['phone', 'Phone'],
  ['email', 'Email'],
  ['birthday', 'Birthday'],
  ['gradeLevel', 'Grade Level'],
  ['medicalNotes', 'Medical/Allergy Notes'],
];

// The DB column for each importable field differs from its JS name in a
// couple of cases (gradeLevel -> grade_level, medicalNotes -> medical_notes).
const IMPORT_FIELD_COLUMNS = {
  address: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',
  phone: 'phone',
  email: 'email',
  birthday: 'birthday',
  gradeLevel: 'grade_level',
  medicalNotes: 'medical_notes',
};

function mergeableFieldsFor(existingMember, row) {
  const updates = {};
  for (const [field] of IMPORT_MERGE_FIELDS) {
    const column = IMPORT_FIELD_COLUMNS[field];
    let incoming = row[field];
    if (!incoming) continue;
    if (existingMember[column]) continue; // never overwrite a value that's already set
    // Same "NaN/NaN/NaN" bug as the CREATE branch in importMembersFromRows
    // below - a raw spreadsheet cell's formatted text isn't the ISO shape
    // the birthday column is stored as, and this merge path writes
    // whatever it's handed straight through on confirm with no read-time
    // chance to fix it up first. An unreadable date is treated the same
    // as one that was never provided.
    if (field === 'birthday') {
      incoming = normalizeBirthdayToISO(incoming);
      if (!incoming) continue;
    }
    updates[field] = incoming;
  }
  return updates;
}

// Links an imported student to its "Parent Name" column by family - a
// family has to actually exist, so if the matched parent doesn't have
// one yet, one is invented from their surname (mirrors the migration in
// db/index.js) so the import's "link student to parent" behavior works.
async function ensureFamilyForParent(parentId) {
  const parent = await db.prepare('SELECT id, name, family_id FROM members WHERE id = ?').get(parentId);
  if (!parent) return null;
  if (parent.family_id != null) return parent.family_id;
  const lastName = parent.name.trim().split(/\s+/).pop() || parent.name;
  let name = lastName;
  let suffix = 1;
  while (await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(name)) {
    suffix++;
    name = `${lastName} ${suffix}`;
  }
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(name)).lastInsertRowid;
  await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, parentId);
  return familyId;
}

// Orchestrates one full import: creates a real member for every
// unmatched-by-name row, links students to parents where the sheet named
// one, and collects (never applies) mergeable field updates for rows
// that matched an existing member by name - those go through
// applyImportMerges below only after the admin reviews and confirms
// them.
async function importMembersFromRows(rows) {
  let created = 0;
  let skipped = 0;
  const nameToId = {};
  const mergeCandidates = [];

  for (const r of rows) {
    const existing = await db.prepare('SELECT * FROM members WHERE active = 1 AND LOWER(name) = LOWER(?)').get(r.name);
    if (existing) {
      nameToId[r.name.toLowerCase()] = existing.id;
      skipped++;
      const updates = mergeableFieldsFor(existing, r);
      if (Object.keys(updates).length > 0) {
        mergeCandidates.push({ memberId: existing.id, memberName: existing.name, updates });
      }
      continue;
    }
    const typeLower = (r.type || '').toLowerCase();
    const memberType = MEMBER_TYPES.includes(typeLower) ? typeLower : 'student';
    const memberCode = await generateMemberCode();
    const info = await db
      .prepare(
        `INSERT INTO members (name, barcode, member_code, member_type, address, city, state, zip, phone, email, birthday, grade_level, medical_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.name,
        memberCode,
        memberCode,
        memberType,
        r.address || null,
        r.city || null,
        r.state || null,
        r.zip || null,
        r.phone || null,
        r.email || null,
        memberType === 'student' && r.birthday ? normalizeBirthdayToISO(r.birthday) : null,
        memberType === 'student' ? r.gradeLevel || null : null,
        r.medicalNotes || null
      );
    nameToId[r.name.toLowerCase()] = info.lastInsertRowid;
    created++;
  }

  let linkedParents = 0;
  for (const r of rows) {
    if (!r.parentName) continue;
    const studentId = nameToId[r.name.toLowerCase()];
    const parentRow = await db
      .prepare("SELECT id FROM members WHERE active = 1 AND member_type IN ('parent', 'admin') AND LOWER(name) = LOWER(?)")
      .get(r.parentName);
    const parentId = nameToId[r.parentName.toLowerCase()] || (parentRow ? parentRow.id : null);
    if (studentId && parentId && studentId !== parentId) {
      const familyId = await ensureFamilyForParent(parentId);
      if (familyId != null) {
        await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, studentId);
        linkedParents++;
      }
    }
  }

  const summary =
    `Imported ${rows.length} row(s): ${created} new member(s) created, ${skipped} already existed` +
    (linkedParents ? `, ${linkedParents} linked to a parent.` : '.');

  return { created, skipped, linkedParents, mergeCandidates, summary };
}

// Applies whichever of the previewed merge candidates the admin actually
// checked, keyed by position across the three parallel arrays a
// confirm-page form submits (memberIds = checked rows only, payloads/
// allMemberIds = every row that was previewed, in the same order).
async function applyImportMerges(memberIds, payloads, allMemberIds) {
  let merged = 0;
  for (let i = 0; i < allMemberIds.length; i++) {
    const id = allMemberIds[i];
    if (!memberIds.includes(id)) continue; // this row's checkbox wasn't checked
    let updates;
    try {
      updates = JSON.parse(payloads[i] || '{}');
    } catch (err) {
      continue;
    }
    const setClauses = [];
    const params = [];
    for (const [field, value] of Object.entries(updates)) {
      const column = IMPORT_FIELD_COLUMNS[field];
      if (!column) continue;
      setClauses.push(`${column} = ?`);
      params.push(value);
    }
    if (setClauses.length === 0) continue;
    params.push(id);
    await db.prepare(`UPDATE members SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    merged++;
  }
  return merged;
}

// Exports every field a member's profile can hold - the same information
// originally collected about them (contact info, address, birthday/grade,
// medical notes, family, rosters) - not just the Name/Type/Family/Rosters
// subset shown in the on-screen table. `members` is membersWithDetails()'s
// own output (utils/members.js).
function buildMembersExportCsvLines(members) {
  const typeLabel = (t) => (t === 'parent' ? 'Parent' : 'Student');
  return [
    toCsvRow([
      'Name',
      'Member ID',
      'Type',
      'Active',
      'Address',
      'City',
      'State',
      'Zip',
      'Phone',
      'Email',
      'Birthday',
      'Grade Level',
      'Medical Notes',
      'Family',
      'Primary Parent',
      'Rosters',
      'Notes',
    ]),
    ...members.map((m) =>
      toCsvRow([
        m.name,
        m.member_code || '',
        typeLabel(m.member_type),
        m.active ? 'Yes' : 'No',
        m.address || '',
        m.city || '',
        m.state || '',
        m.zip || '',
        m.phone || '',
        m.email || '',
        m.birthday || '',
        m.grade_level || '',
        m.medical_notes || '',
        m.familyName || '',
        m.is_primary_parent ? 'Yes' : '',
        m.rosters.map((r) => r.name).join('; '),
        m.notes || '',
      ])
    ),
  ];
}

module.exports = {
  MEMBER_IMPORT_HEADER_ALIASES,
  normalizeImportRow,
  normalizeBirthdayToISO,
  IMPORT_MERGE_FIELDS,
  IMPORT_FIELD_COLUMNS,
  mergeableFieldsFor,
  ensureFamilyForParent,
  importMembersFromRows,
  applyImportMerges,
  buildMembersExportCsvLines,
};
