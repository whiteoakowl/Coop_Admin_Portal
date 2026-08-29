// Admin-defined extra questions on the Membership Form/Add Member forms
// and the public self-registration application - a real request:
// "under members in main admin portal there should be a settings tab
// for editing and adding parts of the membership form." See supabase/
// migrations/20260828000000_membership_form_fields.sql for the schema
// this implements.
const db = require('../db');

const FIELD_TYPES = [
  { key: 'short_text', label: 'Short Text' },
  { key: 'long_text', label: 'Long Text' },
  { key: 'dropdown', label: 'Dropdown' },
  { key: 'checkbox', label: 'Checkbox (yes/no)' },
];

function slugify(label) {
  return (label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'field';
}

function parseField(row) {
  return { ...row, options: row.options ? JSON.parse(row.options) : [] };
}

async function listFields(target) {
  const rows = await db.prepare('SELECT * FROM membership_form_fields WHERE target = ? ORDER BY position, id').all(target);
  return rows.map(parseField);
}

async function getField(id) {
  const row = await db.prepare('SELECT * FROM membership_form_fields WHERE id = ?').get(id);
  return row ? parseField(row) : null;
}

// `optionLines` is the raw textarea value (one choice per line) - only
// meaningful when fieldType is 'dropdown', ignored (stored as an empty
// list) otherwise so a leftover choice list from switching field types
// in the edit form never lingers in the database unused.
async function createField(target, label, fieldType, optionLines, isRequired) {
  const trimmedLabel = (label || '').trim();
  if (!trimmedLabel) return null;
  const key = slugify(trimmedLabel);
  const options = fieldType === 'dropdown' ? (optionLines || '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM membership_form_fields WHERE target = ?').get(target)).m;
  const info = await db
    .prepare('INSERT INTO membership_form_fields (target, field_key, label, field_type, options, is_required, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(target, key, trimmedLabel, fieldType, JSON.stringify(options), isRequired ? 1 : 0, Number(maxPos) + 1);
  return info.lastInsertRowid;
}

async function updateField(id, label, fieldType, optionLines, isRequired) {
  const trimmedLabel = (label || '').trim();
  if (!trimmedLabel) return;
  const options = fieldType === 'dropdown' ? (optionLines || '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  await db
    .prepare('UPDATE membership_form_fields SET label = ?, field_type = ?, options = ?, is_required = ? WHERE id = ?')
    .run(trimmedLabel, fieldType, JSON.stringify(options), isRequired ? 1 : 0, id);
}

async function deleteField(id) {
  await db.prepare('DELETE FROM membership_form_fields WHERE id = ?').run(id);
}

// `values` is { ['f' + fieldId]: rawValue } - the "f" prefix on each
// key matches what views/partials/membership-form-field.ejs actually
// submits: qs (express's urlencoded body parser) treats a purely-
// numeric bracket key like customFields[3] as an array INDEX and
// silently compacts sparse ones together (e.g. customFields[3] and
// customFields[7] collapse into a plain 2-element array, losing which
// id each value belonged to) rather than keeping it as an object keyed
// by that literal number - prefixing with a letter keeps qs from ever
// treating it as an array. Only fields matching `target` are looked at,
// so passing the whole submitted body for both a parent and a child in
// the same request is safe. A checkbox field with no value submitted
// (unchecked) is saved as '0' rather than skipped, so a previously-
// checked answer doesn't just linger unedited.
async function saveFieldValues(memberId, target, values) {
  const fields = await listFields(target);
  for (const field of fields) {
    const key = 'f' + field.id;
    const raw = Object.prototype.hasOwnProperty.call(values || {}, key) ? values[key] : field.field_type === 'checkbox' ? '0' : null;
    if (raw == null) continue;
    await db
      .prepare(
        `INSERT INTO membership_form_field_values (field_id, member_id, value) VALUES (?, ?, ?)
         ON CONFLICT (field_id, member_id) DO UPDATE SET value = excluded.value`
      )
      .run(field.id, memberId, String(raw));
  }
}

async function valuesForMember(memberId) {
  const rows = await db.prepare('SELECT field_id, value FROM membership_form_field_values WHERE member_id = ?').all(memberId);
  const map = {};
  rows.forEach((r) => { map[r.field_id] = r.value; });
  return map;
}

module.exports = { FIELD_TYPES, listFields, getField, createField, updateField, deleteField, saveFieldValues, valuesForMember };
