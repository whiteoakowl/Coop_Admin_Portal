// Student Portal > Games > Minesweeper - classic grid minesweeper, a
// "Flag Mode" toggle stands in for right-click so it also works on touch.
(function () {
  var grid = document.getElementById('mine-grid');
  if (!grid) return;
  var flagsEl = document.getElementById('mine-flags');
  var totalEl = document.getElementById('mine-total');
  var flagToggle = document.getElementById('mine-flag-toggle');
  var resetBtn = document.getElementById('mine-reset');
  var card = document.getElementById('mine-card');

  var SIZE = 8, MINES = 10;
  var cells, flagMode, flagCount, revealedCount, over, banner;

  function neighbors(x, y) {
    var out = [];
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) out.push([nx, ny]);
      }
    }
    return out;
  }

  function newGame() {
    grid.innerHTML = '';
    flagMode = false;
    flagCount = 0;
    revealedCount = 0;
    over = false;
    flagsEl.textContent = '0';
    totalEl.textContent = String(MINES);
    flagToggle.textContent = 'Flag Mode: Off';
    flagToggle.classList.remove('btn-active');
    if (banner) { banner.remove(); banner = null; }

    cells = [];
    for (var y = 0; y < SIZE; y++) {
      var row = [];
      for (var x = 0; x < SIZE; x++) row.push({ mine: false, revealed: false, flagged: false, count: 0 });
      cells.push(row);
    }
    var placed = 0;
    while (placed < MINES) {
      var mx = Math.floor(Math.random() * SIZE), my = Math.floor(Math.random() * SIZE);
      if (!cells[my][mx].mine) { cells[my][mx].mine = true; placed += 1; }
    }
    for (var yy = 0; yy < SIZE; yy++) {
      for (var xx = 0; xx < SIZE; xx++) {
        if (cells[yy][xx].mine) continue;
        cells[yy][xx].count = neighbors(xx, yy).filter(function (n) { return cells[n[1]][n[0]].mine; }).length;
      }
    }

    for (var ry = 0; ry < SIZE; ry++) {
      for (var rx = 0; rx < SIZE; rx++) {
        (function (x, y) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'mine-cell';
          btn.addEventListener('click', function () { reveal(x, y); });
          btn.addEventListener('contextmenu', function (e) { e.preventDefault(); toggleFlag(x, y); });
          grid.appendChild(btn);
          cells[y][x].el = btn;
        })(rx, ry);
      }
    }
  }

  function toggleFlag(x, y) {
    if (over) return;
    var cell = cells[y][x];
    if (cell.revealed) return;
    cell.flagged = !cell.flagged;
    flagCount += cell.flagged ? 1 : -1;
    flagsEl.textContent = String(flagCount);
    cell.el.textContent = cell.flagged ? '🚩' : '';
    cell.el.classList.toggle('mine-cell-flagged', cell.flagged);
  }

  function reveal(x, y) {
    if (over) return;
    if (flagMode) return toggleFlag(x, y);
    var cell = cells[y][x];
    if (cell.revealed || cell.flagged) return;
    cell.revealed = true;
    revealedCount += 1;
    cell.el.classList.add('mine-cell-revealed');

    if (cell.mine) {
      cell.el.textContent = '💣';
      cell.el.classList.add('mine-cell-boom');
      return endGame(false);
    }

    cell.el.textContent = cell.count > 0 ? String(cell.count) : '';
    if (cell.count === 0) {
      neighbors(x, y).forEach(function (n) { reveal(n[0], n[1]); });
    }

    if (revealedCount === SIZE * SIZE - MINES) endGame(true);
  }

  function endGame(won) {
    over = true;
    if (!won) {
      cells.forEach(function (row) {
        row.forEach(function (c) { if (c.mine && !c.revealed) { c.el.textContent = '💣'; c.el.classList.add('mine-cell-revealed'); } });
      });
    }
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = won ? 'You cleared the board! 💥' : 'Boom! Try again.';
    card.insertBefore(banner, resetBtn);
  }

  flagToggle.addEventListener('click', function () {
    flagMode = !flagMode;
    flagToggle.textContent = 'Flag Mode: ' + (flagMode ? 'On' : 'Off');
    flagToggle.classList.toggle('btn-active', flagMode);
  });

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
