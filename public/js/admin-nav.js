(function () {
  const path = window.location.pathname;

  // data-match can hold multiple comma-separated extra paths (e.g. Attendance
  // also covers /admin/absence-list and /admin/checkinout-log).
  function matchPrefixes(el, primary) {
    const extra = (el.dataset.match || '').split(',').map((s) => s.trim());
    return [primary].concat(extra);
  }

  function bestMatch(candidates, getPrefixes) {
    let best = null;
    let bestLen = -1;
    candidates.forEach((item) => {
      getPrefixes(item).forEach((prefix) => {
        if (!prefix) return;
        const matches = path === prefix || path.indexOf(prefix + '/') === 0;
        if (matches && prefix.length > bestLen) {
          best = item;
          bestLen = prefix.length;
        }
      });
    });
    return best;
  }

  // Desktop sidebar: highlight whichever section link best matches the
  // current page (longest prefix match wins). A link can also claim extra
  // paths via data-match (e.g. Volunteers also covers /admin/setup/*).
  const navLinks = Array.prototype.slice.call(document.querySelectorAll('#admin-nav-links a'));
  const activeLink = bestMatch(navLinks, (a) => matchPrefixes(a, a.getAttribute('href')));
  if (activeLink) activeLink.classList.add('active');

  // Mobile dropdown: pre-select whichever option best matches the current
  // page, so it always shows where you are.
  const select = document.getElementById('admin-nav-select');
  if (!select) return;

  const options = Array.prototype.slice.call(select.options);
  const activeOption = bestMatch(options, (opt) => matchPrefixes(opt, opt.value));
  if (activeOption) select.value = activeOption.value;

  select.addEventListener('change', () => {
    if (select.value) window.location = select.value;
  });
})();
