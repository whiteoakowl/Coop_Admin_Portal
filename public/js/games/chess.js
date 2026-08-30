// Student Portal > Games > Chess - 8x8 board, local pass-and-play (see
// views/student-games.ejs's own header comment). Standard per-piece
// movement + capture rules (blocked by pieces in the way, pawns
// promote to queen on reaching the far rank) - deliberately does NOT
// enforce check/checkmate/castling/en passant (out of scope for a
// student-portal pass-and-play game); a captured king ends the game
// immediately instead, which keeps the rules simple enough for two
// students sharing a device without needing a real chess engine.
(function () {
  var boardEl = document.getElementById('chess-board');
  if (!boardEl) return;
  var resetBtn = document.getElementById('chess-reset');
  var turnIndicator = document.getElementById('chess-turn-indicator');
  var card = document.getElementById('chess-card');

  var SIZE = 8;
  var GLYPHS = {
    w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
    b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
  };
  var BACK_ROW = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];

  var grid, turn, selected, over;
  var banner = null;
  var squareEls = [];

  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = [];
    for (var r = 0; r < SIZE; r++) {
      var rowEls = [];
      for (var c = 0; c < SIZE; c++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chess-square ' + ((r + c) % 2 === 0 ? 'chess-square-light' : 'chess-square-dark');
        btn.dataset.r = r;
        btn.dataset.c = c;
        btn.addEventListener('click', function () { onSquareClick(parseInt(this.dataset.r, 10), parseInt(this.dataset.c, 10)); });
        boardEl.appendChild(btn);
        rowEls.push(btn);
      }
      squareEls.push(rowEls);
    }
  }

  function newGame() {
    grid = Array.from({ length: SIZE }, function () { return new Array(SIZE).fill(null); });
    for (var c = 0; c < SIZE; c++) {
      grid[0][c] = { type: BACK_ROW[c], color: 'b' };
      grid[1][c] = { type: 'P', color: 'b' };
      grid[6][c] = { type: 'P', color: 'w' };
      grid[7][c] = { type: BACK_ROW[c], color: 'w' };
    }
    turn = 'w';
    selected = null;
    over = false;
    if (!squareEls.length) buildBoard();
    if (banner) { banner.remove(); banner = null; }
    render();
  }

  function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

  function slideMoves(r, c, dirs, piece) {
    var moves = [];
    dirs.forEach(function (d) {
      var nr = r + d[0], nc = c + d[1];
      while (inBounds(nr, nc)) {
        if (!grid[nr][nc]) {
          moves.push([nr, nc]);
        } else {
          if (grid[nr][nc].color !== piece.color) moves.push([nr, nc]);
          break;
        }
        nr += d[0];
        nc += d[1];
      }
    });
    return moves;
  }

  function pieceMoves(r, c) {
    var piece = grid[r][c];
    if (!piece) return [];
    var moves = [];
    if (piece.type === 'P') {
      var dir = piece.color === 'w' ? -1 : 1;
      var startRow = piece.color === 'w' ? 6 : 1;
      if (inBounds(r + dir, c) && !grid[r + dir][c]) {
        moves.push([r + dir, c]);
        if (r === startRow && !grid[r + dir * 2][c]) moves.push([r + dir * 2, c]);
      }
      [-1, 1].forEach(function (dc) {
        var nr = r + dir, nc = c + dc;
        if (inBounds(nr, nc) && grid[nr][nc] && grid[nr][nc].color !== piece.color) moves.push([nr, nc]);
      });
    } else if (piece.type === 'N') {
      [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]].forEach(function (d) {
        var nr = r + d[0], nc = c + d[1];
        if (inBounds(nr, nc) && (!grid[nr][nc] || grid[nr][nc].color !== piece.color)) moves.push([nr, nc]);
      });
    } else if (piece.type === 'B') {
      moves = slideMoves(r, c, [[-1, -1], [-1, 1], [1, -1], [1, 1]], piece);
    } else if (piece.type === 'R') {
      moves = slideMoves(r, c, [[-1, 0], [1, 0], [0, -1], [0, 1]], piece);
    } else if (piece.type === 'Q') {
      moves = slideMoves(r, c, [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]], piece);
    } else if (piece.type === 'K') {
      [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]].forEach(function (d) {
        var nr = r + d[0], nc = c + d[1];
        if (inBounds(nr, nc) && (!grid[nr][nc] || grid[nr][nc].color !== piece.color)) moves.push([nr, nc]);
      });
    }
    return moves;
  }

  function render() {
    var legal = selected ? pieceMoves(selected[0], selected[1]) : [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var sq = squareEls[r][c];
        var piece = grid[r][c];
        sq.textContent = piece ? GLYPHS[piece.color][piece.type] : '';
        sq.className = 'chess-square ' + ((r + c) % 2 === 0 ? 'chess-square-light' : 'chess-square-dark') +
          (piece ? (piece.color === 'w' ? ' chess-piece-white' : ' chess-piece-black') : '') +
          (selected && selected[0] === r && selected[1] === c ? ' chess-square-selected' : '') +
          (legal.some(function (m) { return m[0] === r && m[1] === c; }) ? ' chess-square-selectable' : '');
      }
    }
    turnIndicator.textContent = over ? turnIndicator.textContent : (turn === 'w' ? 'White to move (You)' : 'Black to move (Opponent)');
  }

  function onSquareClick(r, c) {
    if (over) return;
    var piece = grid[r][c];

    if (selected) {
      var legal = pieceMoves(selected[0], selected[1]);
      var target = legal.find(function (m) { return m[0] === r && m[1] === c; });
      if (target) {
        var captured = grid[r][c];
        grid[r][c] = grid[selected[0]][selected[1]];
        grid[selected[0]][selected[1]] = null;
        if (grid[r][c].type === 'P' && (r === 0 || r === SIZE - 1)) grid[r][c] = { type: 'Q', color: grid[r][c].color };
        selected = null;
        if (captured && captured.type === 'K') return endGame(turn);
        turn = turn === 'w' ? 'b' : 'w';
        return render();
      }
      if (piece && piece.color === turn) { selected = [r, c]; return render(); }
      selected = null;
      return render();
    }

    if (piece && piece.color === turn) { selected = [r, c]; render(); }
  }

  function endGame(winnerColor) {
    over = true;
    render();
    turnIndicator.textContent = winnerColor === 'w' ? 'You win!' : 'Opponent wins!';
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = winnerColor === 'w' ? 'You Win!' : 'Opponent Wins!';
    card.insertBefore(banner, resetBtn);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
