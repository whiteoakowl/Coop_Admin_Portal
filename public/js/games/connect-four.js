// Student Portal > Games > Connect Four - 7x6 drop board, local
// pass-and-play (see views/student-games.ejs's own header comment).
(function () {
  var boardEl = document.getElementById('c4-board');
  if (!boardEl) return;
  var resetBtn = document.getElementById('c4-reset');
  var pill1 = document.getElementById('c4-pill-1');
  var pill2 = document.getElementById('c4-pill-2');
  var card = document.getElementById('c4-card');

  var COLS = 7;
  var ROWS = 6;
  var grid, turn, over;
  var banner = null;
  var cellEls = [];

  function buildBoard() {
    boardEl.innerHTML = '';
    cellEls = [];
    for (var r = 0; r < ROWS; r++) {
      var rowEls = [];
      for (var c = 0; c < COLS; c++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'c4-cell';
        btn.dataset.col = c;
        btn.addEventListener('click', function () { drop(parseInt(this.dataset.col, 10)); });
        boardEl.appendChild(btn);
        rowEls.push(btn);
      }
      cellEls.push(rowEls);
    }
  }

  function newGame() {
    grid = Array.from({ length: ROWS }, function () { return new Array(COLS).fill(0); });
    turn = 1;
    over = false;
    if (!cellEls.length) buildBoard();
    cellEls.forEach(function (row) { row.forEach(function (cell) { cell.removeAttribute('data-piece'); }); });
    if (banner) { banner.remove(); banner = null; }
    updatePills();
  }

  function updatePills() {
    pill1.classList.toggle('game-versus-pill-active', turn === 1 && !over);
    pill2.classList.toggle('game-versus-pill-active', turn === 2 && !over);
  }

  function lowestEmptyRow(col) {
    for (var r = ROWS - 1; r >= 0; r--) {
      if (grid[r][col] === 0) return r;
    }
    return -1;
  }

  function checkWinFrom(r, c, player) {
    var dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (var d = 0; d < dirs.length; d++) {
      var dr = dirs[d][0], dc = dirs[d][1];
      var count = 1;
      for (var sign = -1; sign <= 1; sign += 2) {
        var rr = r + dr * sign, cc = c + dc * sign;
        while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && grid[rr][cc] === player) {
          count += 1;
          rr += dr * sign;
          cc += dc * sign;
        }
      }
      if (count >= 4) return true;
    }
    return false;
  }

  function drop(col) {
    if (over) return;
    var row = lowestEmptyRow(col);
    if (row === -1) return;
    grid[row][col] = turn;
    cellEls[row][col].dataset.piece = String(turn);

    if (checkWinFrom(row, col, turn)) return endGame(turn);
    if (grid[0].every(function (v) { return v !== 0; })) return endGame('draw');

    turn = turn === 1 ? 2 : 1;
    updatePills();
  }

  function endGame(winner) {
    over = true;
    updatePills();
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = winner === 'draw' ? "It's a Draw!" : (winner === 1 ? 'You Win!' : 'Opponent Wins!');
    card.insertBefore(banner, resetBtn);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
