// Create New Event wizard (views/admin-events-new.ejs) - a real request
// to match a reference mockup's 5-step Details/Date & Time/Location/
// Tickets/Additional flow. Every step's fields live in the SAME <form>
// the whole time (this app has no client framework, and Save Draft/
// Publish Event both need every field regardless of which step is
// showing) - this script only ever toggles which .event-wizard-panel is
// visible and which .event-wizard-step circle reads as active/completed,
// it never removes anything from the DOM or the form's own submission.
(function () {
  const stepsBar = document.querySelector('[data-wizard-steps]');
  if (!stepsBar) return;

  const tabs = Array.from(stepsBar.querySelectorAll('[data-step-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-step-panel]'));
  let current = 1;

  function panelFor(n) {
    return panels.find((p) => Number(p.getAttribute('data-step-panel')) === n);
  }

  function goToStep(n) {
    const target = panelFor(n);
    if (!target) return;
    panels.forEach((p) => { p.hidden = p !== target; });
    tabs.forEach((t) => {
      const tn = Number(t.getAttribute('data-step-tab'));
      t.classList.toggle('active', tn === n);
      t.classList.toggle('completed', tn < n);
    });
    current = n;
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // Clicking a circle jumps straight to that step - a real convenience
  // once a couple of steps are already filled in, and harmless on a
  // brand-new event since nothing here is destructive.
  tabs.forEach((t) => {
    t.addEventListener('click', () => goToStep(Number(t.getAttribute('data-step-tab'))));
  });

  document.addEventListener('click', (e) => {
    const next = e.target.closest('[data-next-step]');
    if (next) {
      // Native required-field validation on the CURRENT panel only -
      // reportValidity() on the whole form would also flag fields on
      // steps the admin hasn't reached yet, which reads as broken rather
      // than helpful ("required" on a field they can't even see yet).
      const panel = panelFor(current);
      const invalid = panel && panel.querySelector(':invalid');
      if (invalid) {
        invalid.reportValidity();
        return;
      }
      goToStep(current + 1);
      return;
    }
    const prev = e.target.closest('[data-prev-step]');
    if (prev) goToStep(current - 1);
  });

  // Event Slug auto-fills from Event Title as a convenience (kebab-case,
  // ASCII-only) right up until the admin types into the slug field
  // themselves - after that their own value always wins, same "don't
  // fight what the admin already typed" rule the rest of this app's
  // auto-suggest fields follow (e.g. Floater Assignments' own suggested-
  // floater dropdown).
  const titleInput = document.querySelector('[data-slug-source]');
  const slugInput = document.querySelector('[data-slug-target]');
  if (titleInput && slugInput) {
    let slugTouched = false;
    slugInput.addEventListener('input', () => { slugTouched = true; });
    titleInput.addEventListener('input', () => {
      if (slugTouched) return;
      slugInput.value = titleInput.value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    });
  }
})();
