// Custom Forms (Community & Commerce track, item 7) - one generic,
// reusable form-builder system. See supabase/migrations/
// 20260825070000_custom_forms.sql for the schema this implements.
const db = require('../db');

const FIELD_TYPES = [
  { key: 'short_text', label: 'Short Text' },
  { key: 'long_text', label: 'Long Text' },
  { key: 'number', label: 'Number' },
  { key: 'date', label: 'Date' },
  { key: 'single_choice', label: 'Single Choice' },
  { key: 'multiple_choice', label: 'Multiple Choice' },
  { key: 'dropdown', label: 'Dropdown' },
  { key: 'checkbox', label: 'Checkbox (yes/no)' },
  { key: 'file', label: 'File Upload' },
];
const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice', 'dropdown']);

async function listForms() {
  return db
    .prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM custom_form_submissions s WHERE s.form_id = f.id) AS "submissionCount"
       FROM custom_forms f ORDER BY f.created_at DESC`
    )
    .all();
}

async function getForm(id) {
  return db.prepare('SELECT * FROM custom_forms WHERE id = ?').get(id);
}

async function createForm(title, accountId) {
  const info = await db.prepare('INSERT INTO custom_forms (title, created_by_account_id) VALUES (?, ?)').run(title, accountId);
  return info.lastInsertRowid;
}

async function updateForm(id, data) {
  await db.prepare('UPDATE custom_forms SET title = ?, description = ?, updated_at = now_text() WHERE id = ?').run(data.title, data.description || null, id);
}

async function setFormStatus(id, status) {
  await db.prepare('UPDATE custom_forms SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

async function deleteForm(id) {
  await db.prepare('DELETE FROM custom_forms WHERE id = ?').run(id);
}

// Every field for a form, each with its options (choice-type fields
// only - empty array for everything else, never null, so a view never
// needs to guard against a missing array).
async function fieldsForForm(formId) {
  const fields = await db.prepare('SELECT * FROM custom_form_fields WHERE form_id = ? ORDER BY position, id').all(formId);
  for (const field of fields) {
    field.options = CHOICE_TYPES.has(field.field_type) ? await db.prepare('SELECT * FROM custom_form_field_options WHERE field_id = ? ORDER BY position, id').all(field.id) : [];
  }
  return fields;
}

async function getField(id) {
  return db.prepare('SELECT * FROM custom_form_fields WHERE id = ?').get(id);
}

// optionLabels is a plain array of strings (parsed from one-per-line
// textarea input by the route) - ignored entirely for a non-choice field
// type, same as fieldsForForm never returning options for one.
async function addField(formId, data, optionLabels) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM custom_form_fields WHERE form_id = ?').get(formId)).p) + 1;
  const info = await db
    .prepare('INSERT INTO custom_form_fields (form_id, field_type, label, help_text, is_required, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(formId, data.fieldType, data.label, data.helpText || null, data.isRequired ? 1 : 0, position);
  const fieldId = info.lastInsertRowid;
  if (CHOICE_TYPES.has(data.fieldType)) await setFieldOptions(fieldId, optionLabels);
  return fieldId;
}

async function updateField(id, data, optionLabels) {
  await db.prepare('UPDATE custom_form_fields SET label = ?, help_text = ?, is_required = ? WHERE id = ?').run(data.label, data.helpText || null, data.isRequired ? 1 : 0, id);
  const field = await getField(id);
  if (CHOICE_TYPES.has(field.field_type)) await setFieldOptions(id, optionLabels);
}

async function setFieldOptions(fieldId, optionLabels) {
  await db.prepare('DELETE FROM custom_form_field_options WHERE field_id = ?').run(fieldId);
  let position = 0;
  for (const label of optionLabels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    await db.prepare('INSERT INTO custom_form_field_options (field_id, label, position) VALUES (?, ?, ?)').run(fieldId, trimmed, position);
    position += 1;
  }
}

async function deleteField(id) {
  await db.prepare('DELETE FROM custom_form_fields WHERE id = ?').run(id);
}

// --- Assignments ("specific people or groups") ---

async function assignmentsForForm(formId) {
  return db
    .prepare(
      `SELECT a.*, m.name AS "memberName", r.label AS "roleLabel" FROM custom_form_assignments a
       LEFT JOIN members m ON m.id = a.member_id
       LEFT JOIN roles r ON r.id = a.role_id
       WHERE a.form_id = ? ORDER BY a.created_at`
    )
    .all(formId);
}

async function assignToMember(formId, memberId) {
  await db.prepare('INSERT INTO custom_form_assignments (form_id, member_id) VALUES (?, ?)').run(formId, memberId);
}

async function assignToRole(formId, roleId) {
  await db.prepare('INSERT INTO custom_form_assignments (form_id, role_id) VALUES (?, ?)').run(formId, roleId);
}

async function deleteAssignment(id) {
  await db.prepare('DELETE FROM custom_form_assignments WHERE id = ?').run(id);
}

// A form with no assignment rows at all is open to any signed-in
// account, any role. Otherwise the acting account's own family + roles
// are checked against the assignment rows (a member directly assigned,
// OR any role the account holds assigned) - same "does my family/my
// roles satisfy this" shape canAccessCategory uses for private class
// forums.
async function canAccessForm(formId, family, roleIds) {
  const assignments = await db.prepare('SELECT member_id, role_id FROM custom_form_assignments WHERE form_id = ?').all(formId);
  if (assignments.length === 0) return true;
  const familyIds = new Set(family.map((m) => m.id));
  return assignments.some((a) => (a.member_id && familyIds.has(a.member_id)) || (a.role_id && roleIds.includes(a.role_id)));
}

async function formsVisibleTo(family, roleIds) {
  const published = await db.prepare("SELECT * FROM custom_forms WHERE status = 'published' ORDER BY created_at DESC").all();
  const out = [];
  for (const f of published) {
    if (await canAccessForm(f.id, family, roleIds)) out.push(f);
  }
  return out;
}

// --- Submissions ---

async function submissionFor(formId, memberId) {
  return db.prepare('SELECT * FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, memberId);
}

async function getSubmission(id) {
  return db.prepare('SELECT s.*, m.name AS "memberName" FROM custom_form_submissions s JOIN members m ON m.id = s.member_id WHERE s.id = ?').get(id);
}

async function submissionsForForm(formId) {
  return db
    .prepare(
      `SELECT s.*, m.name AS "memberName" FROM custom_form_submissions s
       JOIN members m ON m.id = s.member_id
       WHERE s.form_id = ? ORDER BY s.submitted_at DESC`
    )
    .all(formId);
}

// answers: [{ fieldId, valueText, optionIds }] - optionIds only used for
// a multiple_choice field, ignored otherwise.
async function submitForm(formId, memberId, accountId, answers) {
  const info = await db.prepare('INSERT INTO custom_form_submissions (form_id, member_id, submitted_by_account_id) VALUES (?, ?, ?)').run(formId, memberId, accountId);
  const submissionId = info.lastInsertRowid;
  for (const answer of answers) {
    const answerInfo = await db.prepare('INSERT INTO custom_form_answers (submission_id, field_id, value_text) VALUES (?, ?, ?)').run(submissionId, answer.fieldId, answer.valueText ?? null);
    if (answer.optionIds && answer.optionIds.length) {
      for (const optionId of answer.optionIds) {
        await db.prepare('INSERT INTO custom_form_answer_choices (answer_id, option_id) VALUES (?, ?)').run(answerInfo.lastInsertRowid, optionId);
      }
    }
  }
  return submissionId;
}

// Every answer for a submission, each with its field (so a view can
// render label/type alongside the value without a second round trip)
// and, for a multiple_choice answer, the selected option labels.
async function answersForSubmission(submissionId) {
  const answers = await db
    .prepare(
      `SELECT a.*, f.label AS "fieldLabel", f.field_type AS "fieldType" FROM custom_form_answers a
       JOIN custom_form_fields f ON f.id = a.field_id
       WHERE a.submission_id = ? ORDER BY f.position, f.id`
    )
    .all(submissionId);
  for (const answer of answers) {
    if (answer.fieldType === 'multiple_choice') {
      const rows = await db
        .prepare(
          `SELECT o.label FROM custom_form_answer_choices c
           JOIN custom_form_field_options o ON o.id = c.option_id
           WHERE c.answer_id = ? ORDER BY o.position`
        )
        .all(answer.id);
      answer.choiceLabels = rows.map((r) => r.label);
    }
  }
  return answers;
}

module.exports = {
  FIELD_TYPES,
  CHOICE_TYPES,
  listForms,
  getForm,
  createForm,
  updateForm,
  setFormStatus,
  deleteForm,
  fieldsForForm,
  getField,
  addField,
  updateField,
  deleteField,
  assignmentsForForm,
  assignToMember,
  assignToRole,
  deleteAssignment,
  canAccessForm,
  formsVisibleTo,
  submissionFor,
  getSubmission,
  submissionsForForm,
  submitForm,
  answersForSubmission,
};
