// Student Portal > Games > Memory Match - local single-player, flip pairs
// of face-down tiles until every pair is found (see student-games.ejs's
// own header comment on why these are all client-side).
(function () {
  var grid = document.getElementById('match-grid');
  if (!grid) return;
  var movesEl = document.getElementById('match-moves');
  var resetBtn = document.getElementById('match-reset');
  var card = document.getElementById('match-card');

  var ICONS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐨', '🦁'];

  var tiles, first, second, matches, moves, locked, banner;

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function newGame() {
    var deck = shuffle(ICONS.concat(ICONS));
    grid.innerHTML = '';
    tiles = [];
    first = null; second = null; matches = 0; moves = 0; locked = false;
    movesEl.textContent = '0';
    if (banner) { banner.remove(); banner = null; }

    deck.forEach(function (icon, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'match-tile';
      btn.dataset.icon = icon;
      btn.dataset.i = i;
      btn.setAttribute('aria-label', 'Card');
      btn.addEventListener('click', function () { flip(btn); });
      grid.appendChild(btn);
      tiles.push(btn);
    });
  }

  function flip(btn) {
    if (locked || btn.classList.contains('match-tile-flipped') || btn.classList.contains('match-tile-matched')) return;
    btn.textContent = btn.dataset.icon;
    btn.classList.add('match-tile-flipped');

    if (!first) { first = btn; return; }
    second = btn;
    moves += 1;
    movesEl.textContent = String(moves);
    locked = true;

    if (first.dataset.icon === second.dataset.icon) {
      first.classList.add('match-tile-matched');
      second.classList.add('match-tile-matched');
      matches += 1;
      first = null; second = null; locked = false;
      if (matches === ICONS.length) endGame();
    } else {
      setTimeout(function () {
        first.textContent = ''; first.classList.remove('match-tile-flipped');
        second.textContent = ''; second.classList.remove('match-tile-flipped');
        first = null; second = null; locked = false;
      }, 650);
    }
  }

  function endGame() {
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = 'You found every pair in ' + moves + ' moves!';
    card.insertBefore(banner, resetBtn);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
