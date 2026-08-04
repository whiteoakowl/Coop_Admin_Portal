(function () {
  const toggle = document.getElementById('nav-toggle');
  const inner = document.getElementById('admin-nav-inner');
  if (!toggle || !inner) return;

  toggle.addEventListener('click', () => {
    const open = inner.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Close the menu once a link is chosen, so navigating doesn't leave it stuck open.
  inner.querySelectorAll('nav a').forEach((a) => {
    a.addEventListener('click', () => {
      inner.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
})();
