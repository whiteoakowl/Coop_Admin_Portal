(function () {
  const form = document.getElementById('name-tag-form');
  if (!form) return;

  if (form.dataset.redirectHome === '1') {
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  }
})();
