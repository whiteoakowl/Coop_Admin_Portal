(function () {
  const form = document.getElementById('absence-form');
  if (!form) return;

  if (form.dataset.redirectHome === '1') {
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  }
})();
