(function () {
  const select = document.getElementById('admin-nav-select');
  if (!select) return;

  // Pre-select whichever option best matches the current page, so the
  // mobile dropdown always shows where you are (longest prefix match wins,
  // since every page path starts with "/admin").
  const path = window.location.pathname;
  let best = null;
  Array.prototype.forEach.call(select.options, (opt) => {
    const matches = path === opt.value || path.indexOf(opt.value + '/') === 0;
    if (matches && (!best || opt.value.length > best.length)) best = opt.value;
  });
  if (best) select.value = best;

  select.addEventListener('change', () => {
    if (select.value) window.location = select.value;
  });
})();
