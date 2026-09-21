// Live preview for the Edit Event Image upload (views/admin-events-
// builder.ejs) - a real request: "after you hit upload photo button it
// should show the image before saving." Shows the just-chosen file
// immediately via a local object URL, without waiting for the real
// upload's own round trip to the server.
(function () {
  document.querySelectorAll('[data-event-image-input]').forEach(function (input) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var preview = input.closest('.member-form-full').querySelector('[data-event-image-preview]');
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
    });
  });
})();
