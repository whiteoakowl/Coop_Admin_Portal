// Live preview for the Diploma design dialog (views/parent-academics-
// diplomas.ejs). A real request: "Be able to design and create a
// diploma with four templates to choose from, colors and edit name,
// dates, and signatures" - every field below mirrors a form input the
// parent is actively editing straight onto the same certificate markup
// (partials/diploma-certificate.ejs) their Save button will persist, so
// "design" means watching the real certificate change, not guessing from
// a plain form and finding out only after printing.
(function () {
  function wireDesigner(dialog) {
    const form = dialog.querySelector('form');
    const preview = dialog.querySelector('.diploma-cert');
    if (!form || !preview) return;

    const field = (name) => form.querySelector(`[name="${name}"]`);
    const template = field('template');
    const color = field('color');
    const title = field('title');
    const displayName = field('displayName');
    const issuedDate = field('issuedDate');
    const bodyText = field('bodyText');
    const sig1Name = field('signature1Name');
    const sig1Title = field('signature1Title');
    const sig2Name = field('signature2Name');
    const sig2Title = field('signature2Title');

    const titleEl = preview.querySelector('.diploma-cert-title');
    const nameEl = preview.querySelector('.diploma-cert-name');
    const dateEl = preview.querySelector('.diploma-cert-date');
    const bodyEl = preview.querySelector('.diploma-cert-body');
    const sig1El = preview.querySelector('[data-signature="1"]');
    const sig2El = preview.querySelector('[data-signature="2"]');

    function updateSignature(block, nameInput, titleInput) {
      if (!block) return;
      const hasName = nameInput && nameInput.value.trim();
      block.style.display = hasName ? '' : 'none';
      const nameField = block.querySelector('.diploma-cert-signature-name');
      const titleField = block.querySelector('.diploma-cert-signature-title');
      if (nameField && nameInput) nameField.textContent = nameInput.value;
      if (titleField && titleInput) titleField.textContent = titleInput.value;
    }

    function update() {
      if (template) preview.className = 'diploma-cert diploma-tpl-' + template.value;
      if (color) preview.style.setProperty('--diploma-color', color.value);
      if (titleEl && title) titleEl.textContent = title.value || 'Diploma of Completion';
      if (nameEl) nameEl.textContent = (displayName && displayName.value.trim()) || nameEl.dataset.defaultName || '';
      if (dateEl && issuedDate) dateEl.textContent = 'Issued ' + (issuedDate.value || '');
      if (bodyEl && bodyText) {
        bodyEl.textContent = bodyText.value;
        bodyEl.style.display = bodyText.value.trim() ? '' : 'none';
      }
      updateSignature(sig1El, sig1Name, sig1Title);
      updateSignature(sig2El, sig2Name, sig2Title);
    }

    [template, color, title, displayName, issuedDate, bodyText, sig1Name, sig1Title, sig2Name, sig2Title]
      .filter(Boolean)
      .forEach((el) => el.addEventListener('input', update));
    update();
  }

  document.querySelectorAll('dialog.diploma-design-dialog').forEach(wireDesigner);
})();
