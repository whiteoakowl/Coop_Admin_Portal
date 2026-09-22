// Co-op Admin Documents' upload form (views/admin-documents.ejs) - when
// Storage is configured (data-direct-upload="true", set from
// storageConfigured on the server), this intercepts submit and PUTs the
// file (and optional image) straight to Supabase Storage via a signed
// upload URL, instead of posting the bytes through this app's own
// Netlify Function - see routes/admin-documents.js's own comment on why
// (a real request: "I can't upload larger files"). A local/LAN install
// with no Storage configured has no such ceiling to work around, so its
// form has no data-direct-upload attribute and submits as a plain
// multipart POST, same as before - this script no-ops entirely then.
(function () {
  const form = document.getElementById('document-upload-form');
  if (!form || form.dataset.directUpload !== 'true') return;

  async function uploadToSignedUrl(file) {
    const initRes = await fetch('/admin/documents/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      body: JSON.stringify({ filename: file.name }),
    });
    const initData = await initRes.json();
    if (!initRes.ok) throw new Error(initData.error || 'Could not start the upload.');
    const putRes = await fetch(initData.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });
    if (!putRes.ok) throw new Error(`Upload of "${file.name}" failed.`);
    return { key: initData.key, name: file.name, type: file.type };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[data-upload-status]');
    const fileInput = form.querySelector('input[name="file"]');
    const imageInput = form.querySelector('input[name="image"]');
    const titleInput = form.querySelector('input[name="title"]');
    if (!fileInput.files[0]) return;

    submitBtn.disabled = true;
    if (status) status.textContent = 'Uploading…';
    try {
      const fileResult = await uploadToSignedUrl(fileInput.files[0]);
      const imageResult = imageInput && imageInput.files[0] ? await uploadToSignedUrl(imageInput.files[0]) : null;

      const completeRes = await fetch('/admin/documents/upload-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: JSON.stringify({
          title: titleInput.value,
          fileKey: fileResult.key,
          fileOriginalName: fileResult.name,
          fileMimeType: fileResult.type,
          imageKey: imageResult ? imageResult.key : null,
          imageMimeType: imageResult ? imageResult.type : null,
        }),
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) throw new Error(completeData.error || 'Upload failed.');
      window.location.href = completeData.redirect;
    } catch (err) {
      submitBtn.disabled = false;
      if (status) status.textContent = err.message;
    }
  });
})();
