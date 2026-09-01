// Monday/Wednesday/All filter for the Student Portal's "My Classes" card
// grid (views/student-classes.ejs) - a student's own enrolled-class list
// is always small, so this filters client-side (same pattern as public/
// js/games/games-filter.js) instead of a server round trip.
(function () {
  var tabs = document.querySelectorAll('.classes-day-filter .day-toggle-option');
  var cards = document.querySelectorAll('.class-card');
  if (!tabs.length) return;

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var filter = tab.dataset.filter;
      cards.forEach(function (card) {
        var show = filter === 'all' || card.dataset.day === filter;
        if (show) card.removeAttribute('hidden');
        else card.setAttribute('hidden', '');
      });
    });
  });
})();
