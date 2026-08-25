// Member-facing Custom Forms (Community & Commerce track, item 7),
// mounted at /forms (server.js). Members-only for every route - a form
// is either open to any signed-in account (no assignments at all) or
// targeted at specific people/roles, never public. A submission is
// filled out on behalf of one member of the acting account's own family
// (self included) - one submission per (form, member), matching the
// unique constraint the migration itself puts on that pair.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const { createStorageClient, uploadFile, downloadFile, generateKey } = require('../utils/storage');
const customForms = require('../utils/customForms');

router.use(requirePortalAuth);

// A private bucket (like admin-documents.js's own `documents` bucket) -
// a form submission can carry a real uploaded document (e.g. a signed
// waiver), so this is proxied through an authenticated download route
// below rather than a public URL, unlike Events/Directory's own image
// uploads.
const FORM_FILES_BUCKET = 'custom-form-files';
// Deliberately OUTSIDE public/ (unlike admin-documents.js's own local-
// disk fallback, which lives under public/uploads/documents and is
// therefore reachable by anyone who knows/guesses the key, since
// express.static serves the whole public/ tree unconditionally) - a
// submitted form file is proxied exclusively through the authenticated
// /forms/files/:answerId route below, so there's no reason to also make
// it directly fetchable by URL.
const FORM_FILES_DIR = path.join(__dirname, '..', 'private-uploads', 'custom-form-files');
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(FORM_FILES_DIR)) fs.mkdirSync(FORM_FILES_DIR, { recursive: true });

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

async function roleIdsForAccount(req) {
  return req.portalRoles.map((r) => r.id);
}

router.get('/', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const roleIds = await roleIdsForAccount(req);
  const forms = await customForms.formsVisibleTo(family, roleIds);
  res.render('custom-forms-list', { title: 'Forms', forms });
});

// Must come BEFORE the generic '/:id' route below - otherwise Express
// would match "files" itself as an :id here first (route matching is by
// definition order within a router, not by specificity).
router.get('/files/:answerId', async (req, res) => {
  const answer = await db
    .prepare(
      `SELECT a.*, s.member_id, s.form_id FROM custom_form_answers a
       JOIN custom_form_submissions s ON s.id = a.submission_id
       WHERE a.id = ?`
    )
    .get(req.params.answerId);
  if (!answer || !answer.value_text) return res.status(404).render('404', { title: 'Not Found' });

  const isModerator = req.portalPermissions.has('manage_forms');
  if (!isModerator) {
    const family = await familyForAccount(req.portalAccount.id);
    if (!family.some((m) => m.id === answer.member_id)) {
      return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this file.", backHref: '/forms', backLabel: 'Back to Forms' });
    }
  }

  if (storageClient) {
    const buffer = await downloadFile(storageClient, FORM_FILES_BUCKET, answer.value_text);
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.send(buffer);
  }
  const filePath = path.join(FORM_FILES_DIR, path.basename(answer.value_text));
  if (!fs.existsSync(filePath)) return res.status(404).render('404', { title: 'Not Found' });
  res.sendFile(filePath);
});

router.get('/:id', async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  if (!form || form.status !== 'published') return res.status(404).render('404', { title: 'Not Found' });
  const family = await familyForAccount(req.portalAccount.id);
  const roleIds = await roleIdsForAccount(req);
  if (!(await customForms.canAccessForm(form.id, family, roleIds))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this form.", backHref: '/forms', backLabel: 'Back to Forms' });
  }
  const fields = await customForms.fieldsForForm(form.id);
  res.render('custom-forms-fill', { title: form.title, form, fields, family, error: req.query.error || null });
});

router.get('/:id/mine/:memberId', async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  if (!form) return res.status(404).render('404', { title: 'Not Found' });
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === parseInt(req.params.memberId, 10))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "That's not your submission.", backHref: '/forms', backLabel: 'Back to Forms' });
  }
  const submission = await customForms.submissionFor(form.id, req.params.memberId);
  if (!submission) return res.status(404).render('404', { title: 'Not Found' });
  const answers = await customForms.answersForSubmission(submission.id);
  res.render('custom-forms-submitted', { title: form.title, form, submission, answers });
});

router.post('/:id/submit', upload.any(), async (req, res) => {
  const form = await customForms.getForm(req.params.id);
  if (!form || form.status !== 'published') return res.status(404).render('404', { title: 'Not Found' });
  const family = await familyForAccount(req.portalAccount.id);
  const roleIds = await roleIdsForAccount(req);
  if (!(await customForms.canAccessForm(form.id, family, roleIds))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this form.", backHref: '/forms', backLabel: 'Back to Forms' });
  }
  const memberId = parseInt(req.body.memberId, 10);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(`/forms/${form.id}?error=` + encodeURIComponent('You can only submit for yourself or your own family.'));
  }
  if (await customForms.submissionFor(form.id, memberId)) {
    return res.redirect(`/forms/${form.id}/mine/${memberId}`);
  }

  const fields = await customForms.fieldsForForm(form.id);
  const filesByField = new Map((req.files || []).map((f) => [f.fieldname, f]));
  const answers = [];
  for (const field of fields) {
    if (field.is_required && field.field_type !== 'file' && field.field_type !== 'multiple_choice' && !req.body[`field_${field.id}`]) {
      return res.redirect(`/forms/${form.id}?error=` + encodeURIComponent(`"${field.label}" is required.`));
    }
    if (field.field_type === 'multiple_choice') {
      const raw = req.body[`field_${field.id}`];
      const optionIds = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((v) => parseInt(v, 10));
      if (field.is_required && optionIds.length === 0) {
        return res.redirect(`/forms/${form.id}?error=` + encodeURIComponent(`"${field.label}" is required.`));
      }
      answers.push({ fieldId: field.id, valueText: null, optionIds });
    } else if (field.field_type === 'file') {
      const file = filesByField.get(`field_${field.id}`);
      if (field.is_required && !file) {
        return res.redirect(`/forms/${form.id}?error=` + encodeURIComponent(`"${field.label}" is required.`));
      }
      let key = null;
      if (file) {
        key = storageClient
          ? await uploadFile(storageClient, FORM_FILES_BUCKET, file.buffer, file.originalname, file.mimetype)
          : (() => {
              const k = generateKey(file.originalname);
              fs.writeFileSync(path.join(FORM_FILES_DIR, k), file.buffer);
              return k;
            })();
      }
      answers.push({ fieldId: field.id, valueText: key });
    } else if (field.field_type === 'checkbox') {
      answers.push({ fieldId: field.id, valueText: req.body[`field_${field.id}`] ? '1' : '0' });
    } else {
      answers.push({ fieldId: field.id, valueText: (req.body[`field_${field.id}`] || '').trim() });
    }
  }

  await customForms.submitForm(form.id, memberId, req.portalAccount.id, answers);
  res.redirect(`/forms/${form.id}/mine/${memberId}`);
});

module.exports = router;
