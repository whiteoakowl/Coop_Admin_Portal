// Public Homepage theme editor - live-ish preview pane + Desktop/Mobile
// toggle (Main Admin > Settings > Public Homepage). A real request:
// "Should have the exact webpage editing features as Shopify... a live
// preview pane on the right showing the actual rendered homepage...
// which visibly updates as settings change." This app has no frontend
// build step and no real-time DOM-diffing infra, so "live" here means
// the preview iframe reloads itself a short debounce after the last
// color/font/announcement-bar field change - the same "good enough, not
// pixel-perfect realtime" tradeoff this app already makes elsewhere
// (see public/js/clear-notice-params.js's own comment). Block/menu-tab
// content changes already cause a full page reload via their own
// existing POST forms/dialogs (unchanged), which rebuilds this iframe's
// src fresh for free - no extra code needed for those.
(function () {
  if (window.__homepageThemeEditorInstalled) return;
  window.__homepageThemeEditorInstalled = true;

  const form = document.getElementById('homepage-theme-settings-form');
  const iframe = document.getElementById('homepage-theme-preview-iframe');
  if (!form || !iframe) return;
  const previewBaseUrl = iframe.getAttribute('data-preview-base') || iframe.getAttribute('src');

  // Color swatch <-> hex text input - the swatch alone (this app's usual
  // plain <input type="color"> convention - see views/parent-family-
  // school-settings.ejs) gives no readable value to put on the preview
  // iframe's own query string, so each color role pairs one with a
  // same-named text input that actually gets submitted.
  form.querySelectorAll('[data-theme-color-picker]').forEach((picker) => {
    const hexInput = document.getElementById(picker.getAttribute('data-pairs-with'));
    if (!hexInput) return;
    picker.addEventListener('input', () => {
      hexInput.value = picker.value;
      scheduleReload();
    });
    hexInput.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) picker.value = hexInput.value;
    });
  });

  let reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadPreview, 400);
  }

  function reloadPreview() {
    const params = new URLSearchParams();
    form.querySelectorAll('[data-theme-field]').forEach((field) => {
      if (field.type === 'checkbox') {
        params.set(field.name, field.checked ? '1' : '0');
      } else if (field.value) {
        params.set(field.name, field.value);
      }
    });
    iframe.src = previewBaseUrl + '?' + params.toString();
  }

  form.querySelectorAll('[data-theme-field]').forEach((field) => {
    field.addEventListener('input', scheduleReload);
    field.addEventListener('change', scheduleReload);
  });

  // Desktop/Mobile toggle - just resizes the iframe's own wrapper via a
  // data attribute CSS already keys off (public/css/styles.css), same
  // idea as this app's own responsive breakpoints - no server round-
  // trip, no separate mobile markup to maintain.
  const frameWrap = document.querySelector('.homepage-theme-preview-frame-wrap');
  document.querySelectorAll('.homepage-theme-viewport-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.homepage-theme-viewport-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      if (frameWrap) frameWrap.setAttribute('data-viewport', btn.getAttribute('data-viewport'));
    });
  });
})();
