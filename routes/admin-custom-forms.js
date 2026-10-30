// Main Admin's Custom Forms builder (Community & Commerce track, item
// 7) - mounted at /main-admin/forms (server.js), gated the same way
// every other Track B admin section is. One generic system: field
// types, assignments, submissions, and export all live here rather than
// a one-off table per form (the handoff's own explicit instruction).
//
// Jotform-style builder upgrade (a real request: "Main admin portal,
// forms tab. Should have full editing features and view just like
// jotform. Exactly.") adds: pages/sections with drag-reorder, a fuller
// field-type palette with full per-field editing (placeholder, default
// value, conditional "only show when" logic, which page it's on) and
// drag-reorder within a page, per-form theme (color + button style),
// and a sortable/filterable submissions list. See utils/customForms.js
// for the schema/logic this renders.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const customForms = require('../utils/customForms');
const auditLog = require('../utils/auditLog');
const { byLastName } = require('../utils/members');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_forms'));

router.get('/', async (req, res) => {
  const forms = await customForms.listForms();
  res.render('admin-custom-forms-list', { title: 'Custom Forms', forms, notice: req.query.notice || null });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/forms?notice=' + encodeURIComponent('Title is required.'));
  const id = await customForms.createForm(title, req.portalAccount.id);
  res.redirect(`/main-admin/forms/${id}/builder`);
});

async function loadBuilder(req, res) {
  const form = await customForms.getForm(req.params.id);
  if (!form) return res.status(404).render('404', { title: 'Not Found' });
  const pages = await customForms.pagesWithFields(form.id);
  // Every field in the form, flattened, for the "depends on" dropdown a
  // conditional-logic rule picks its controlling field from - a rule can
  // point at a field on any other page, not just its own.
  const allFields = pages.flatMap((p) => p.fields);
  for (const page of pages) {
    for (const field of page.fields) field.conditionalLogicParsed = customForms.parseConditionalLogic(field.conditional_logic);
    page.conditionalLogicParsed = customForms.parseConditionalLogic(page.conditional_logic);
  }
  const assignments = await customForms.assignmentsForForm(form.id);
  const roles = await db.prepare('SELECT id, key, label FROM roles ORDER BY label').all();
  const members = (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).sort(byLastName);
  res.render('admin-custom-forms-builder', {
    title: form.title,
    form,
    pages,
    allFields,
    assignments,
    roles,
    members,
    fieldTypes: customForms.FIELD_TYPES,
    choiceTypes: [...customForms.CHOICE_TYPES],
    displayOnlyTypes: [...customForms.DISPLAY_ONLY_TYPES],
    conditionOperators: customForms.CONDITION_OPERATORS,
    themeButtonStyles: customForms.THEME_BUTTON_STYLES,
    ratingMax: customForms.RATING_MAX,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}
router.get('/:id/builder', loadBuilder);

router.post('/:id', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Title is required.'));
  await customForms.updateForm(req.params.id, {
    title,
    description: (req.body.description || '').trim(),
    themePrimaryColor: req.body.themePrimaryColor,
    themeButtonStyle: req.body.themeButtonStyle,
  });
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'published', 'closed'].includes(status)) return res.redirect(`/main-admin/forms/${req.params.id}/builder`);
  await customForms.setFormStatus(req.params.id, status);
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent(`Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  await customForms.deleteForm(req.params.id);
  await auditLog.record(req.portalAccount.id, 'form_deleted', 'custom_form', req.params.id, form?.title);
  res.redirect('/main-admin/forms?notice=' + encodeURIComponent('Form deleted.'));
});

// --- Pages / Sections ---

router.post('/:id/pages', async (req, res) => {
  await customForms.addPage(req.params.id, {
    title: req.body.title,
    description: req.body.description,
    conditionalLogic: customForms.conditionalLogicFromBody(req.body),
  });
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Page added.'));
});

router.post('/:id/pages/:pageId/update', async (req, res) => {
  await customForms.updatePage(req.params.pageId, {
    title: req.body.title,
    description: req.body.description,
    conditionalLogic: customForms.conditionalLogicFromBody(req.body),
  });
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Page saved.'));
});

router.post('/:id/pages/:pageId/delete', async (req, res) => {
  const deleted = await customForms.deletePage(req.params.pageId, req.params.id);
  const notice = deleted ? 'Page removed; its fields moved to the remaining page.' : "A form must have at least one page - add another page before removing this one.";
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent(notice));
});

// Drag-reorder, AJAX - same shape (and literally the same client script,
// public/js/homepage-block-reorder.js) as the Public Homepage builder's
// own block/menu-item reordering: only ever the final on-screen order is
// sent, a failed save is a silent no-op.
router.post('/:id/pages/reorder', express.json(), async (req, res) => {
  const pageIds = [].concat(req.body.blockIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await customForms.reorderPages(req.params.id, pageIds);
  res.json({ ok: true });
});

function parseOptionLabels(raw) {
  return (raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function fieldDataFromBody(body) {
  return {
    helpText: (body.helpText || '').trim(),
    placeholder: (body.placeholder || '').trim(),
    defaultValue: (body.defaultValue || '').trim(),
    isRequired: !!body.isRequired,
    pageId: body.pageId,
    conditionalLogic: customForms.conditionalLogicFromBody(body),
  };
}

router.post('/:id/fields', async (req, res) => {
  const label = (req.body.label || '').trim();
  const fieldType = req.body.fieldType;
  if (!label || !customForms.FIELD_TYPES.some((f) => f.key === fieldType)) {
    return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Label and a valid field type are required.'));
  }
  await customForms.addField(req.params.id, { fieldType, label, ...fieldDataFromBody(req.body) }, parseOptionLabels(req.body.options));
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Field added.'));
});

router.post('/:id/fields/:fieldId/update', async (req, res) => {
  const label = (req.body.label || '').trim();
  if (!label) return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Label is required.'));
  await customForms.updateField(req.params.fieldId, { label, ...fieldDataFromBody(req.body) }, parseOptionLabels(req.body.options));
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Field updated.'));
});

router.post('/:id/fields/:fieldId/delete', async (req, res) => {
  await customForms.deleteField(req.params.fieldId);
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Field removed.'));
});

// Drag-reorder within one page - the dragged container's own
// data-reorder-url carries both the form id (the route) and the page id
// (the body), so fields never jump between pages just by being dragged.
router.post('/:id/fields/reorder', express.json(), async (req, res) => {
  const fieldIds = [].concat(req.body.blockIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const pageId = parseInt(req.body.pageId, 10);
  await customForms.reorderFields(req.params.id, pageId, fieldIds);
  res.json({ ok: true });
});

router.post('/:id/assignments', async (req, res) => {
  if (req.body.memberId) await customForms.assignToMember(req.params.id, req.body.memberId);
  else if (req.body.roleId) await customForms.assignToRole(req.params.id, req.body.roleId);
  else return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Choose a person or a role.'));
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Assigned.'));
});

router.post('/:id/assignments/:assignmentId/delete', async (req, res) => {
  await customForms.deleteAssignment(req.params.assignmentId);
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Assignment removed.'));
});

router.get('/:id/submissions', async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  if (!form) return res.status(404).render('404', { title: 'Not Found' });
  const sort = req.query.sort === 'member' ? 'member' : 'submitted_at';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const q = (req.query.q || '').trim();
  // Grows every time someone submits that form - paginated in-memory
  // the same way as every other ongoing list/log (utils/pagination.js),
  // on top of the sort/filter custom_forms applies in SQL first.
  const allSubmissions = await customForms.submissionsForForm(form.id, { sort, dir, q });
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allSubmissions, parsePage(req.query.page), pageSize);
  const qParam = q ? `q=${encodeURIComponent(q)}&` : '';
  res.render('admin-custom-forms-submissions', {
    title: `Submissions - ${form.title}`,
    form,
    submissions: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: `/main-admin/forms/${form.id}/submissions?${qParam}sort=${sort}&dir=${dir}&`,
    sort,
    dir,
    q,
  });
});

// A real latent bug this upgrade surfaces and fixes: this route MUST
// come before the generic '/:id/submissions/:submissionId' below, or
// Express matches the literal path segment "export" as a :submissionId
// first (route matching is by definition order, not by specificity -
// routes/custom-forms.js's own '/files/:answerId' vs '/:id' ordering
// note says the same thing) - getSubmission('export') then 500s trying
// to use that string as an integer id. The CSV export link has been on
// admin-custom-forms-submissions.ejs since this module shipped, so it
// never actually worked until this reorder.
router.get('/:id/submissions/export', async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  if (!form) return res.status(404).render('404', { title: 'Not Found' });
  const fields = (await customForms.fieldsForForm(form.id)).filter((f) => !customForms.DISPLAY_ONLY_TYPES.has(f.field_type));
  const submissions = await customForms.submissionsForForm(form.id);
  const lines = [toCsvRow(['Member', 'Submitted At', ...fields.map((f) => f.label)])];
  for (const s of submissions) {
    const answers = await customForms.answersForSubmission(s.id);
    const byField = new Map(answers.map((a) => [a.field_id, a]));
    const row = [s.memberName, s.submitted_at];
    for (const f of fields) {
      const a = byField.get(f.id);
      if (!a) row.push('');
      else if (f.field_type === 'multiple_choice') row.push((a.choiceLabels || []).join('; '));
      else row.push(a.value_text || '');
    }
    lines.push(toCsvRow(row));
  }
  sendCsv(res, `${form.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-submissions.csv`, lines);
});

router.get('/:id/submissions/:submissionId', async (req, res) => {
  const submission = await customForms.getSubmission(req.params.submissionId);
  if (!submission || String(submission.form_id) !== req.params.id) return res.status(404).render('404', { title: 'Not Found' });
  const form = await customForms.getForm(submission.form_id);
  const answers = await customForms.answersForSubmission(submission.id);
  res.render('admin-custom-forms-submission-detail', { title: `Submission - ${form.title}`, form, submission, answers });
});

module.exports = router;
