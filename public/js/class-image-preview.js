// Live preview for the Class Settings > Class Photo upload (views/admin-
// class-schedule-manage.ejs) - a real request: "the class photo should
// automatically show the image under class settings before saving."
// Shows the just-chosen file immediately via a local object URL, without
// waiting for the real upload's own round trip to the server - same
// pattern as public/js/event-image-preview.js.
(function () {
  document.querySelectorAll('[data-class-image-input]').forEach(function (input) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var preview = input.closest('.member-form-full').querySelector('[data-class-image-preview]');
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
    });
  });
})();
