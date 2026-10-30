// Custom Forms (Community & Commerce track, item 7) - one generic,
// reusable form-builder system. See supabase/migrations/
// 20260825070000_custom_forms.sql for the original schema this
// implements, and supabase/migrations/20261225010000_custom_forms_
// builder_upgrade.sql for the Jotform-style upgrade below (pages,
// conditional logic, placeholder/default value, per-form theme) - a
// real request: "Main admin portal, forms tab. Should have full
// editing features and view just like jotform. Exactly."
const db = require('../db');

// Grouped the way a real Jotform-style field palette presents them
// (views/admin-custom-forms-builder.ejs renders one button per entry,
// grouped by `group`) rather than one flat <select> - "a fuller
// field-type palette" from the handoff. `icon` names a symbol in
// views/partials/icon-sprite.ejs.
const FIELD_TYPES = [
  { key: 'short_text', label: 'Short Text', group: 'Text', icon: 'type' },
  { key: 'long_text', label: 'Paragraph Text', group: 'Text', icon: 'align-left' },
  { key: 'email', label: 'Email', group: 'Text', icon: 'mail' },
  { key: 'phone', label: 'Phone Number', group: 'Text', icon: 'phone' },
  { key: 'url', label: 'Website / Link', group: 'Text', icon: 'link' },
  { key: 'number', label: 'Number', group: 'Text', icon: 'sliders' },
  { key: 'date', label: 'Date', group: 'Text', icon: 'calendar-check' },
  { key: 'single_choice', label: 'Single Choice', group: 'Choice', icon: 'circle' },
  { key: 'multiple_choice', label: 'Multiple Choice', group: 'Choice', icon: 'list-check' },
  { key: 'dropdown', label: 'Dropdown', group: 'Choice', icon: 'chevron-down' },
  { key: 'checkbox', label: 'Checkbox (yes/no)', group: 'Choice', icon: 'check-circle' },
  { key: 'rating', label: 'Star Rating (1-5)', group: 'Rating', icon: 'star' },
  { key: 'scale', label: 'Opinion Scale (1-10)', group: 'Rating', icon: 'sliders' },
  { key: 'file', label: 'File Upload', group: 'File', icon: 'upload' },
  { key: 'heading', label: 'Heading', group: 'Layout', icon: 'type' },
  { key: 'paragraph', label: 'Paragraph Text Block', group: 'Layout', icon: 'align-left' },
];
const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice', 'dropdown']);
// Layout-only elements (Jotform's own "Heading"/"Text" widgets) - never
// collect an answer, never required, never shown in a submission or the
// CSV export. Everything else below treats these the same as any other
// field UNLESS it specifically checks this set first.
const DISPLAY_ONLY_TYPES = new Set(['heading', 'paragraph']);
const RATING_MAX = { rating: 5, scale: 10 };

// Conditional logic ("only show this field/section when...") - stored as
// one JSON column (conditional_logic, on both custom_form_fields and
// custom_form_pages): {"fieldId": <id>, "operator": "<key below>",
// "value": "<string>"}. The same five operators drive both the admin's
// own rule-builder dropdown and the public fill-out page's plain-JS
// evaluator (public/js/custom-form-runtime.js mirrors evaluateCondition
// below exactly, by design, so the two can never disagree).
const CONDITION_OPERATORS = [
  { key: 'equals', label: 'is' },
  { key: 'not_equals', label: 'is not' },
  { key: 'contains', label: 'contains' },
  { key: 'is_answered', label: 'is answered' },
  { key: 'is_blank', label: 'is blank' },
];
const THEME_BUTTON_STYLES = ['rounded', 'square', 'pill'];

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

// Every new form starts with exactly one page ("Page 1") so the builder
// always has somewhere to put a field, and a form nobody ever turns into
// a real multi-page wizard just renders as the single page it always
// did (addPage below is what a "fuller" form actually uses).
async function createForm(title, accountId) {
  const info = await db.prepare('INSERT INTO custom_forms (title, created_by_account_id) VALUES (?, ?)').run(title, accountId);
  const formId = info.lastInsertRowid;
  await db.prepare('INSERT INTO custom_form_pages (form_id, title, position) VALUES (?, ?, 0)').run(formId, 'Page 1');
  return formId;
}

async function updateForm(id, data) {
  const buttonStyle = THEME_BUTTON_STYLES.includes(data.themeButtonStyle) ? data.themeButtonStyle : 'rounded';
  const primaryColor = /^#[0-9a-f]{6}$/i.test(data.themePrimaryColor || '') ? data.themePrimaryColor : '#2e6da4';
  await db
    .prepare(
      `UPDATE custom_forms SET title = ?, description = ?, theme_primary_color = ?, theme_button_style = ?, updated_at = now_text() WHERE id = ?`
    )
    .run(data.title, data.description || null, primaryColor, buttonStyle, id);
}

async function setFormStatus(id, status) {
  await db.prepare('UPDATE custom_forms SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

async function deleteForm(id) {
  await db.prepare('DELETE FROM custom_forms WHERE id = ?').run(id);
}

// --- Pages / Sections ---
// "Multi-page/section forms... while a short form still works exactly
// as a single page." A page IS a section here - the builder's own
// progress indicator (custom-forms-fill.ejs) only ever shows once a
// form has more than one.

async function listPagesForForm(formId) {
  return db.prepare('SELECT * FROM custom_form_pages WHERE form_id = ? ORDER BY position, id').all(formId);
}

async function getPage(id) {
  return db.prepare('SELECT * FROM custom_form_pages WHERE id = ?').get(id);
}

async function addPage(formId, data) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM custom_form_pages WHERE form_id = ?').get(formId)).p) + 1;
  const info = await db
    .prepare('INSERT INTO custom_form_pages (form_id, title, description, position, conditional_logic) VALUES (?, ?, ?, ?, ?)')
    .run(formId, (data.title || '').trim() || null, (data.description || '').trim() || null, position, data.conditionalLogic || null);
  return info.lastInsertRowid;
}

async function updatePage(id, data) {
  await db
    .prepare('UPDATE custom_form_pages SET title = ?, description = ?, conditional_logic = ? WHERE id = ?')
    .run((data.title || '').trim() || null, (data.description || '').trim() || null, data.conditionalLogic || null, id);
}

// Refuses to delete a form's only page (a form must always have
// somewhere for its fields to live) - returns false rather than
// throwing, so the route can show a plain notice instead of a 500.
// Any field still on the deleted page moves to whichever page is left
// with the lowest position, never silently losing its place in the
// form.
async function deletePage(id, formId) {
  const pages = await listPagesForForm(formId);
  if (pages.length <= 1) return false;
  const fallback = pages.find((p) => p.id !== Number(id));
  await db.prepare('UPDATE custom_form_fields SET page_id = ? WHERE page_id = ?').run(fallback.id, id);
  await db.prepare('DELETE FROM custom_form_pages WHERE id = ?').run(id);
  return true;
}

async function reorderPages(formId, pageIds) {
  await db.withTransaction(async (tx) => {
    for (let i = 0; i < pageIds.length; i += 1) {
      await tx.prepare('UPDATE custom_form_pages SET position = ? WHERE id = ? AND form_id = ?').run(i, pageIds[i], formId);
    }
  });
}

// Pages (ordered), each carrying its own `.fields` (ordered) - the one
// shape both the builder's field list and the public fill-out page's
// per-page rendering are built from, so they can never drift apart. Any
// field whose page_id doesn't resolve (shouldn't happen post-backfill,
// but cheap to guard) falls back onto the form's first page rather than
// vanishing from the builder entirely.
async function pagesWithFields(formId) {
  const pages = await listPagesForForm(formId);
  const fields = await fieldsForForm(formId);
  const byPageId = new Map(pages.map((p) => [p.id, p]));
  for (const page of pages) page.fields = [];
  for (const field of fields) {
    const page = byPageId.get(field.page_id) || pages[0];
    if (page) page.fields.push(field);
  }
  return pages;
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
  const pageId = await resolvePageId(formId, data.pageId);
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM custom_form_fields WHERE form_id = ? AND page_id = ?').get(formId, pageId)).p) + 1;
  const info = await db
    .prepare(
      `INSERT INTO custom_form_fields (form_id, page_id, field_type, label, help_text, placeholder, default_value, is_required, position, conditional_logic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      formId,
      pageId,
      data.fieldType,
      data.label,
      data.helpText || null,
      data.placeholder || null,
      data.defaultValue || null,
      data.isRequired ? 1 : 0,
      position,
      data.conditionalLogic || null
    );
  const fieldId = info.lastInsertRowid;
  if (CHOICE_TYPES.has(data.fieldType)) await setFieldOptions(fieldId, optionLabels);
  return fieldId;
}

// Falls back to the form's first page when no valid pageId was given
// (e.g. an older /fields POST that predates the page picker, or a
// pageId from a different form entirely) - a field is never left
// without a page.
async function resolvePageId(formId, pageId) {
  const id = parseInt(pageId, 10);
  if (id) {
    const page = await db.prepare('SELECT id FROM custom_form_pages WHERE id = ? AND form_id = ?').get(id, formId);
    if (page) return page.id;
  }
  const pages = await listPagesForForm(formId);
  return pages[0] ? pages[0].id : null;
}

async function updateField(id, data, optionLabels) {
  const field = await getField(id);
  const pageId = await resolvePageId(field.form_id, data.pageId ?? field.page_id);
  let position = field.position;
  if (pageId !== field.page_id) {
    position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM custom_form_fields WHERE form_id = ? AND page_id = ?').get(field.form_id, pageId)).p) + 1;
  }
  await db
    .prepare(
      `UPDATE custom_form_fields SET label = ?, help_text = ?, placeholder = ?, default_value = ?, is_required = ?, page_id = ?, position = ?, conditional_logic = ? WHERE id = ?`
    )
    .run(
      data.label,
      data.helpText || null,
      data.placeholder || null,
      data.defaultValue || null,
      data.isRequired ? 1 : 0,
      pageId,
      position,
      data.conditionalLogic || null,
      id
    );
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

// Drag-and-drop reordering (public/js/homepage-block-reorder.js, reused
// as-is - see the builder view's own comment on why nothing new was
// written for this). Only ever the final on-screen order is sent, same
// "a failed save is a silent no-op" tradeoff every other drag-reorder
// route in this app already makes. Scoped to (formId, pageId) in the
// WHERE clause so a stale or tampered id from a different form/page can
// never move a field it doesn't own.
async function reorderFields(formId, pageId, fieldIds) {
  await db.withTransaction(async (tx) => {
    for (let i = 0; i < fieldIds.length; i += 1) {
      await tx.prepare('UPDATE custom_form_fields SET position = ? WHERE id = ? AND form_id = ? AND page_id = ?').run(i, fieldIds[i], formId, pageId);
    }
  });
}

// --- Conditional logic ---

// Parses + validates a stored conditional_logic JSON string (or an
// already-parsed object, for callers building a rule fresh) - anything
// malformed, or naming an operator CONDITION_OPERATORS doesn't
// recognize, is treated as "no rule" (always visible) rather than
// throwing, since this runs on every page render.
function parseConditionalLogic(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !parsed.fieldId || !CONDITION_OPERATORS.some((o) => o.key === parsed.operator)) return null;
    return { fieldId: Number(parsed.fieldId), operator: parsed.operator, value: parsed.value != null ? String(parsed.value) : '' };
  } catch (err) {
    return null;
  }
}

// Builds the JSON string to store from the builder's own rule-builder
// fields (conditionFieldId/conditionOperator/conditionValue) - returns
// null (no rule, i.e. "always show") when the admin left the controlling
// field unset.
function conditionalLogicFromBody(body) {
  const fieldId = parseInt(body.conditionFieldId, 10);
  const operator = body.conditionOperator;
  if (!fieldId || !CONDITION_OPERATORS.some((o) => o.key === operator)) return null;
  return JSON.stringify({ fieldId, operator, value: (body.conditionValue || '').trim() });
}

// The one evaluator both the submit route's server-side required-field
// check AND the public fill-out/builder-preview's plain-JS live hide/show
// (public/js/custom-form-runtime.js) are built from - deliberately kept
// this small and pure (no DB access) so it's trivial to mirror in client
// JS and to unit-test directly. valuesByFieldId maps a fieldId to either
// a single string (most field types - the submitted text/selected
// label) or an array of strings (multiple_choice's selected option
// labels).
function evaluateCondition(rule, valuesByFieldId) {
  if (!rule) return true;
  const raw = valuesByFieldId ? valuesByFieldId[rule.fieldId] : undefined;
  const values = (Array.isArray(raw) ? raw : [raw]).map((v) => (v === undefined || v === null ? '' : String(v)));
  const needle = (rule.value || '').toLowerCase();
  switch (rule.operator) {
    case 'equals':
      return values.some((v) => v.toLowerCase() === needle);
    case 'not_equals':
      return !values.some((v) => v.toLowerCase() === needle);
    case 'contains':
      return values.some((v) => v.toLowerCase().includes(needle));
    case 'is_answered':
      return values.some((v) => v.trim() !== '');
    case 'is_blank':
      return !values.some((v) => v.trim() !== '');
    default:
      return true;
  }
}

// A field is visible only when BOTH its own conditional_logic rule AND
// its page's own section-level rule evaluate true - a field on a hidden
// page is never visible on its own. `pages` is the array
// pagesWithFields/listPagesForForm already returns; passing it in
// (rather than re-querying per field) is what lets the submit route
// check every field's visibility in one pass over data it already has.
function isFieldVisible(field, valuesByFieldId, pages) {
  if (!evaluateCondition(parseConditionalLogic(field.conditional_logic), valuesByFieldId)) return false;
  if (pages && field.page_id) {
    const page = pages.find((p) => p.id === field.page_id);
    if (page && !isPageVisible(page, valuesByFieldId)) return false;
  }
  return true;
}

function isPageVisible(page, valuesByFieldId) {
  return evaluateCondition(parseConditionalLogic(page.conditional_logic), valuesByFieldId);
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

// A real submissions experience: sortable (by submitted date or member
// name) and filterable (by member name) - the same ?sort=/?dir=/?q=
// query-string shape the pagination helper already layers underneath
// (routes/admin-custom-forms.js paginates whatever this returns). Still
// an in-memory-friendly single query, same "a co-op's own data is never
// large enough for this to be the bottleneck" reasoning utils/
// pagination.js's own header comment gives.
async function submissionsForForm(formId, options = {}) {
  const sortColumn = options.sort === 'member' ? 'm.name' : 's.submitted_at';
  const sortDir = options.dir === 'asc' ? 'ASC' : 'DESC';
  const needle = (options.q || '').trim();
  let sql = `SELECT s.*, m.name AS "memberName" FROM custom_form_submissions s JOIN members m ON m.id = s.member_id WHERE s.form_id = ?`;
  const params = [formId];
  if (needle) {
    sql += ' AND LOWER(m.name) LIKE ?';
    params.push(`%${needle.toLowerCase()}%`);
  }
  sql += ` ORDER BY ${sortColumn} ${sortDir}`;
  return db.prepare(sql).all(...params);
}

// answers: [{ fieldId, valueText, optionIds }] - optionIds only used for
// a multiple_choice field, ignored otherwise. A DISPLAY_ONLY_TYPES field
// (heading/paragraph) is never passed in here at all - routes/custom-
// forms.js skips it entirely before building this array, so it never
// gets an answer row.
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
  DISPLAY_ONLY_TYPES,
  RATING_MAX,
  CONDITION_OPERATORS,
  THEME_BUTTON_STYLES,
  listForms,
  getForm,
  createForm,
  updateForm,
  setFormStatus,
  deleteForm,
  listPagesForForm,
  getPage,
  addPage,
  updatePage,
  deletePage,
  reorderPages,
  pagesWithFields,
  fieldsForForm,
  getField,
  addField,
  updateField,
  deleteField,
  reorderFields,
  parseConditionalLogic,
  conditionalLogicFromBody,
  evaluateCondition,
  isFieldVisible,
  isPageVisible,
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
