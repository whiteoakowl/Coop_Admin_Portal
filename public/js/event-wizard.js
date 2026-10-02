// Create New Event page (views/admin-events-new.ejs). Used to step
// through Details/Tickets/Permissions as separate panels - a real
// request ("no permissions page when creating the event... event
// creation will now just be one page") flattened it to a single page, so
// the only thing left here is the Event Slug auto-fill below.
(function () {
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
