// Live preview + auto-upload for the Edit Event Image field (views/admin-
// events-builder.ejs) - a real request: "when you upload a photo for an
// individual event it automatically shows the photo so we don't need the
// upload button, just choose file." Shows the just-chosen file instantly
// via a local object URL, then submits this form itself straight to the
// real POST /:id/image route - no separate Upload button/click needed,
// and no "chosen but not yet uploaded" state where the local preview
// looks saved but nothing has actually reached the server yet (the real
// bug the same request also reported: "when you click save the photo
// disappears" - clicking the overall Save Event Details button only ever
// submitted the Details form, never this one).
//
// Uses requestSubmit(), not the older submit() - a real bug report:
// "when you try to upload a photo on an event it says error page,
// something went wrong, page was open too long" (csrfProtection.js's own
// session-expired message). form.submit() bypasses the DOM's `submit`
// event entirely by spec, so public/js/csrf.js's own document-level
// submit listener - which appends this multipart form's required
// ?_csrf= token to its action URL - never ran, and every auto-submitted
// upload got rejected as if the token were simply missing.
// requestSubmit() goes through the normal submit process (same as a real
// click on a submit button), so the listener fires like it does for
// every other form on the page.
(function () {
  document.querySelectorAll('[data-event-image-input]').forEach(function (input) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var preview = input.closest('.member-form-full').querySelector('[data-event-image-preview]');
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
      input.form.requestSubmit();
    });
  });
})();
