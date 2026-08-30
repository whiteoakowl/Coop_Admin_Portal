// Student Portal > Games > Battleship - single player vs a simple
// computer. Your fleet is auto-placed; click the enemy grid to attack.
(function () {
  var enemyGrid = document.getElementById('battle-enemy-grid');
  if (!enemyGrid) return;
  var youGrid = document.getElementById('battle-you-grid');
  var statusEl = document.getElementById('battle-status');
  var resetBtn = document.getElementById('battle-reset');
  var card = document.getElementById('battle-card');

  var SIZE = 6;
  var SHIPS = [3, 2, 2];

  var enemyBoard, youBoard, over, turn, banner;

  function emptyBoard() {
    var b = [];
    for (var y = 0; y < SIZE; y++) {
      var row = [];
      for (var x = 0; x < SIZE; x++) row.push({ ship: false, hit: false });
      b.push(row);
    }
    return b;
  }

  function placeShips(board) {
    SHIPS.forEach(function (len) {
      var placed = false;
      while (!placed) {
        var horiz = Math.random() < 0.5;
        var x = Math.floor(Math.random() * SIZE);
        var y = Math.floor(Math.random() * SIZE);
        var cells = [];
        var fits = true;
        for (var i = 0; i < len; i++) {
          var cx = horiz ? x + i : x;
          var cy = horiz ? y : y + i;
          if (cx >= SIZE || cy >= SIZE || board[cy][cx].ship) { fits = false; break; }
          cells.push([cx, cy]);
        }
        if (fits) { cells.forEach(function (c) { board[c[1]][c[0]].ship = true; }); placed = true; }
      }
    });
    return board;
  }

  function totalShipCells() { return SHIPS.reduce(function (a, b) { return a + b; }, 0); }

  function render(board, gridEl, isEnemy) {
    gridEl.innerHTML = '';
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        (function (x, y) {
          var cell = board[y][x];
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'battle-cell';
          if (cell.hit) {
            btn.classList.add(cell.ship ? 'battle-cell-hit' : 'battle-cell-miss');
            btn.textContent = cell.ship ? '🔥' : '•';
          } else if (!isEnemy && cell.ship) {
            btn.classList.add('battle-cell-ship');
          }
          if (isEnemy) btn.addEventListener('click', function () { attack(x, y); });
          gridEl.appendChild(btn);
        })(x, y);
      }
    }
  }

  function newGame() {
    enemyBoard = placeShips(emptyBoard());
    youBoard = placeShips(emptyBoard());
    over = false;
    turn = 'you';
    if (banner) { banner.remove(); banner = null; }
    statusEl.textContent = 'Your turn - sink the enemy fleet!';
    render(enemyBoard, enemyGrid, true);
    render(youBoard, youGrid, false);
  }

  function countHitShips(board) {
    var n = 0;
    board.forEach(function (row) { row.forEach(function (c) { if (c.ship && c.hit) n += 1; }); });
    return n;
  }

  function attack(x, y) {
    if (over || turn !== 'you') return;
    var cell = enemyBoard[y][x];
    if (cell.hit) return;
    cell.hit = true;
    render(enemyBoard, enemyGrid, true);
    if (countHitShips(enemyBoard) === totalShipCells()) return endGame(true);
    turn = 'cpu';
    statusEl.textContent = "Computer's turn...";
    setTimeout(cpuTurn, 500);
  }

  function cpuTurn() {
    var x, y;
    do {
      x = Math.floor(Math.random() * SIZE);
      y = Math.floor(Math.random() * SIZE);
    } while (youBoard[y][x].hit);
    youBoard[y][x].hit = true;
    render(youBoard, youGrid, false);
    if (countHitShips(youBoard) === totalShipCells()) return endGame(false);
    turn = 'you';
    statusEl.textContent = 'Your turn - sink the enemy fleet!';
  }

  function endGame(won) {
    over = true;
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = won ? 'You sank the whole fleet! ⚓' : 'The computer sank your fleet!';
    card.insertBefore(banner, resetBtn);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
