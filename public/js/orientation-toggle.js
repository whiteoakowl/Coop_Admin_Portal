// Orientation tab's own circles (views/admin-orientation.ejs) - a real
// request: "circle check boxes that show green when complete." Each is a
// plain button, not a real checkbox, so clicking it can immediately
// fetch-toggle the field and flip color without a page reload - same
// fetch-on-click shape public/js/class-settings-autosave.js already uses
// for the Class Settings tab's own checkboxes, just a button instead of
// an <input type="checkbox">.
(function () {
  document.addEventListener('click', async (e) => {
    const dot = e.target.closest('[data-orientation-toggle]');
    if (!dot) return;
    const memberId = dot.getAttribute('data-member-id');
    const day = dot.getAttribute('data-day');
    const field = dot.getAttribute('data-field');
    const nextValue = dot.getAttribute('data-complete') !== '1';

    dot.disabled = true;
    try {
      const res = await fetch(`/admin/orientation/${memberId}/${day}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: new URLSearchParams({ field, value: nextValue ? '1' : '0' }).toString(),
      });
      if (!res.ok) throw new Error('toggle failed');
      dot.setAttribute('data-complete', nextValue ? '1' : '0');
      dot.setAttribute('aria-pressed', String(nextValue));
      dot.classList.toggle('orientation-dot-complete', nextValue);
      const row = dot.closest('tr');
      if (row) {
        const dots = row.querySelectorAll('[data-orientation-toggle]');
        const doneCount = Array.from(dots).filter((d) => d.getAttribute('data-complete') === '1').length;
        const percentCell = row.querySelector('td:last-child');
        if (percentCell) percentCell.textContent = `${Math.round((doneCount / dots.length) * 100)}%`;
      }
    } catch (err) {
      // Reflects the same "reordering is a nice-to-have, not page-
      // breaking" tradeoff other fetch-on-click actions in this app take -
      // nothing changed visually since the attribute update above hasn't
      // run yet, so there's nothing to revert.
    } finally {
      dot.disabled = false;
    }
  });
})();
