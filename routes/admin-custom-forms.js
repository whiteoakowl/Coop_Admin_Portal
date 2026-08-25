// Main Admin's Custom Forms builder (Community & Commerce track, item
// 7) - mounted at /main-admin/forms (server.js), gated the same way
// every other Track B admin section is. One generic system: field
// types, assignments, submissions, and export all live here rather than
// a one-off table per form (the handoff's own explicit instruction).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const customForms = require('../utils/customForms');

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
  const fields = await customForms.fieldsForForm(form.id);
  const assignments = await customForms.assignmentsForForm(form.id);
  const roles = await db.prepare('SELECT id, key, label FROM roles ORDER BY label').all();
  const members = await db.prepare("SELECT id, name FROM members WHERE active = 1 ORDER BY LOWER(name)").all();
  res.render('admin-custom-forms-builder', {
    title: form.title,
    form,
    fields,
    assignments,
    roles,
    members,
    fieldTypes: customForms.FIELD_TYPES,
    choiceTypes: [...customForms.CHOICE_TYPES],
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}
router.get('/:id/builder', loadBuilder);

router.post('/:id', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Title is required.'));
  await customForms.updateForm(req.params.id, { title, description: (req.body.description || '').trim() });
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'published', 'closed'].includes(status)) return res.redirect(`/main-admin/forms/${req.params.id}/builder`);
  await customForms.setFormStatus(req.params.id, status);
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent(`Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  await customForms.deleteForm(req.params.id);
  res.redirect('/main-admin/forms?notice=' + encodeURIComponent('Form deleted.'));
});

function parseOptionLabels(raw) {
  return (raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

router.post('/:id/fields', async (req, res) => {
  const label = (req.body.label || '').trim();
  const fieldType = req.body.fieldType;
  if (!label || !customForms.FIELD_TYPES.some((f) => f.key === fieldType)) {
    return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Label and a valid field type are required.'));
  }
  await customForms.addField(req.params.id, { fieldType, label, helpText: (req.body.helpText || '').trim(), isRequired: !!req.body.isRequired }, parseOptionLabels(req.body.options));
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Field added.'));
});

router.post('/:id/fields/:fieldId/update', async (req, res) => {
  const label = (req.body.label || '').trim();
  if (!label) return res.redirect(`/main-admin/forms/${req.params.id}/builder?error=` + encodeURIComponent('Label is required.'));
  await customForms.updateField(req.params.fieldId, { label, helpText: (req.body.helpText || '').trim(), isRequired: !!req.body.isRequired }, parseOptionLabels(req.body.options));
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Field updated.'));
});

router.post('/:id/fields/:fieldId/delete', async (req, res) => {
  await customForms.deleteField(req.params.fieldId);
  res.redirect(`/main-admin/forms/${req.params.id}/builder?notice=` + encodeURIComponent('Field removed.'));
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
  const submissions = await customForms.submissionsForForm(form.id);
  res.render('admin-custom-forms-submissions', { title: `Submissions - ${form.title}`, form, submissions });
});

router.get('/:id/submissions/:submissionId', async (req, res) => {
  const submission = await customForms.getSubmission(req.params.submissionId);
  if (!submission || String(submission.form_id) !== req.params.id) return res.status(404).render('404', { title: 'Not Found' });
  const form = await customForms.getForm(submission.form_id);
  const answers = await customForms.answersForSubmission(submission.id);
  res.render('admin-custom-forms-submission-detail', { title: `Submission - ${form.title}`, form, submission, answers });
});

router.get('/:id/submissions/export', async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  if (!form) return res.status(404).render('404', { title: 'Not Found' });
  const fields = await customForms.fieldsForForm(form.id);
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

module.exports = router;
