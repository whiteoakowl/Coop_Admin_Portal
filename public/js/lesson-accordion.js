// Lesson list accordion (views/partials/lessons-view.ejs) - a real
// request: "When you click the lesson title bar the assignment list
// expands below. If you click on another assignment bar the previous one
// closes." Only one [data-lesson-accordion-panel] open at a time, scoped
// to its own [data-lesson-accordion] container so more than one class's
// lesson list could exist on the same page without interfering.
(function () {
  if (window.__lessonAccordionInstalled) return;
  window.__lessonAccordionInstalled = true;

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-lesson-accordion-trigger]');
    if (!trigger) return;
    var container = trigger.closest('[data-lesson-accordion]');
    if (!container) return;
    var item = trigger.closest('.lesson-accordion-item');
    var panel = item ? item.querySelector('[data-lesson-accordion-panel]') : null;
    var willOpen = panel ? panel.hidden : false;

    container.querySelectorAll('[data-lesson-accordion-trigger]').forEach(function (otherTrigger) {
      var otherItem = otherTrigger.closest('.lesson-accordion-item');
      var otherPanel = otherItem ? otherItem.querySelector('[data-lesson-accordion-panel]') : null;
      if (otherPanel) otherPanel.hidden = true;
      otherTrigger.setAttribute('aria-expanded', 'false');
    });

    if (panel && willOpen) {
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }
  });
})();
