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
(function () {
  document.querySelectorAll('[data-event-image-input]').forEach(function (input) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var preview = input.closest('.member-form-full').querySelector('[data-event-image-preview]');
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
      input.form.submit();
    });
  });
})();
