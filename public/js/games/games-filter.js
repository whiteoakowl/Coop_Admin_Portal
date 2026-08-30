(function () {
  var tabs = document.querySelectorAll('.game-filter-tab');
  var cards = document.querySelectorAll('.game-tile');
  if (!tabs.length) return;

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('game-filter-tab-active'); });
      tab.classList.add('game-filter-tab-active');
      var filter = tab.dataset.filter;
      cards.forEach(function (card) {
        var show = filter === 'all' || card.dataset.category === filter;
        if (show) card.removeAttribute('hidden');
        else card.setAttribute('hidden', '');
      });
    });
  });
})();
