// Student Portal > Games > Checkers - 8x8 board, local pass-and-play
// (see views/student-games.ejs's own header comment). Standard men-move-
// diagonally-forward + jump-to-capture rules, kinged on reaching the far
// row; single-jump-per-turn (no forced multi-jump chains) to keep the
// interaction simple for a first pass.
(function () {
  var boardEl = document.getElementById('checkers-board');
  if (!boardEl) return;
  var resetBtn = document.getElementById('checkers-reset');
  var scoreYouEl = document.getElementById('checkers-score-you');
  var scoreOppEl = document.getElementById('checkers-score-opp');
  var turnDot = document.getElementById('checkers-turn-dot');
  var turnLabel = document.getElementById('checkers-turn-label');
  var card = document.getElementById('checkers-card');

  var SIZE = 8;
  var grid, turn, selected, over;
  var banner = null;
  var squareEls = [];

  function isDark(r, c) {
    return (r + c) % 2 === 1;
  }

  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = [];
    for (var r = 0; r < SIZE; r++) {
      var rowEls = [];
      for (var c = 0; c < SIZE; c++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'checkers-square ' + (isDark(r, c) ? 'checkers-square-dark' : 'checkers-square-light');
        btn.dataset.r = r;
        btn.dataset.c = c;
        if (isDark(r, c)) btn.addEventListener('click', function () { onSquareClick(parseInt(this.dataset.r, 10), parseInt(this.dataset.c, 10)); });
        boardEl.appendChild(btn);
        rowEls.push(btn);
      }
      squareEls.push(rowEls);
    }
  }

  function newGame() {
    grid = Array.from({ length: SIZE }, function () { return new Array(SIZE).fill(null); });
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (!isDark(r, c)) continue;
        if (r < 3) grid[r][c] = { player: 2, king: false };
        else if (r > 4) grid[r][c] = { player: 1, king: false };
      }
    }
    turn = 1;
    selected = null;
    over = false;
    if (!squareEls.length) buildBoard();
    if (banner) { banner.remove(); banner = null; }
    render();
  }

  function pieceMoves(r, c) {
    var piece = grid[r][c];
    if (!piece) return { moves: [], captures: [] };
    var dirs = piece.king ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] : (piece.player === 1 ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]]);
    var moves = [], captures = [];
    dirs.forEach(function (d) {
      var nr = r + d[0], nc = c + d[1];
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
        if (!grid[nr][nc]) {
          moves.push([nr, nc]);
        } else if (grid[nr][nc].player !== piece.player) {
          var jr = r + d[0] * 2, jc = c + d[1] * 2;
          if (jr >= 0 && jr < SIZE && jc >= 0 && jc < SIZE && !grid[jr][jc]) {
            captures.push([jr, jc, nr, nc]);
          }
        }
      }
    });
    return { moves: moves, captures: captures };
  }

  function anyCaptureAvailable(player) {
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (grid[r][c] && grid[r][c].player === player && pieceMoves(r, c).captures.length) return true;
      }
    }
    return false;
  }

  function render() {
    var mustCapture = anyCaptureAvailable(turn);
    var legal = selected ? pieceMoves(selected[0], selected[1]) : { moves: [], captures: [] };
    var destinations = (mustCapture ? legal.captures.map(function (m) { return [m[0], m[1]]; }) : legal.moves.concat(legal.captures.map(function (m) { return [m[0], m[1]]; })));

    var you = 0, opp = 0;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var sq = squareEls[r][c];
        sq.innerHTML = '';
        sq.classList.remove('checkers-square-selectable');
        var piece = grid[r][c];
        if (piece) {
          if (piece.player === 1) you += 1; else opp += 1;
          var span = document.createElement('span');
          span.className = 'checkers-piece checkers-piece-p' + piece.player + (piece.king ? ' checkers-piece-king' : '') + (selected && selected[0] === r && selected[1] === c ? ' checkers-piece-selected' : '');
          sq.appendChild(span);
        }
        if (isDark(r, c) && destinations.some(function (d) { return d[0] === r && d[1] === c; })) {
          sq.classList.add('checkers-square-selectable');
        }
      }
    }
    scoreYouEl.textContent = you;
    scoreOppEl.textContent = opp;
    turnDot.style.background = turn === 1 ? 'var(--green)' : 'var(--red)';
    turnLabel.textContent = over ? turnLabel.textContent : (turn === 1 ? 'Your Turn' : "Opponent's Turn");
  }

  function onSquareClick(r, c) {
    if (over) return;
    var piece = grid[r][c];
    var mustCapture = anyCaptureAvailable(turn);

    if (piece && piece.player === turn) {
      var legal = pieceMoves(r, c);
      if (mustCapture && !legal.captures.length) return;
      selected = [r, c];
      return render();
    }

    if (selected) {
      var moves = pieceMoves(selected[0], selected[1]);
      var capture = moves.captures.find(function (m) { return m[0] === r && m[1] === c; });
      var simpleMove = !mustCapture && moves.moves.some(function (m) { return m[0] === r && m[1] === c; });
      if (capture) {
        grid[r][c] = grid[selected[0]][selected[1]];
        grid[selected[0]][selected[1]] = null;
        grid[capture[2]][capture[3]] = null;
        crownIfNeeded(r, c);
        selected = null;
        finishTurn();
      } else if (simpleMove) {
        grid[r][c] = grid[selected[0]][selected[1]];
        grid[selected[0]][selected[1]] = null;
        crownIfNeeded(r, c);
        selected = null;
        finishTurn();
      }
    }
  }

  function crownIfNeeded(r, c) {
    var piece = grid[r][c];
    if (!piece) return;
    if ((piece.player === 1 && r === 0) || (piece.player === 2 && r === SIZE - 1)) piece.king = true;
  }

  function finishTurn() {
    var you = 0, opp = 0;
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      if (grid[r][c]) { if (grid[r][c].player === 1) you += 1; else opp += 1; }
    }
    if (you === 0 || opp === 0) return endGame(you === 0 ? 2 : 1);
    turn = turn === 1 ? 2 : 1;
    render();
  }

  function endGame(winner) {
    over = true;
    render();
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = winner === 1 ? 'You Win!' : 'Opponent Wins!';
    card.insertBefore(banner, resetBtn);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
