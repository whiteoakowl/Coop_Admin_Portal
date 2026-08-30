// Student Portal > Games > Tic-Tac-Toe - local pass-and-play, no server
// round-trip (see views/student-games.ejs's own header comment).
(function () {
  var board = document.getElementById('ttt-board');
  if (!board) return;
  var cells = Array.from(board.querySelectorAll('.ttt-cell'));
  var resetBtn = document.getElementById('ttt-reset');
  var pillX = document.getElementById('ttt-pill-x');
  var pillO = document.getElementById('ttt-pill-o');
  var card = document.getElementById('ttt-card');

  var WINS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  var state, turn, over;
  var banner = null;

  function newGame() {
    state = new Array(9).fill(null);
    turn = 'X';
    over = false;
    cells.forEach(function (cell) {
      cell.textContent = '';
      cell.removeAttribute('data-mark');
      cell.disabled = false;
    });
    if (banner) { banner.remove(); banner = null; }
    updateTurnPills();
  }

  function updateTurnPills() {
    pillX.classList.toggle('game-versus-pill-active', turn === 'X' && !over);
    pillO.classList.toggle('game-versus-pill-active', turn === 'O' && !over);
  }

  function checkWinner() {
    for (var i = 0; i < WINS.length; i++) {
      var line = WINS[i];
      if (state[line[0]] && state[line[0]] === state[line[1]] && state[line[1]] === state[line[2]]) {
        return state[line[0]];
      }
    }
    return state.every(Boolean) ? 'draw' : null;
  }

  function endGame(winner) {
    over = true;
    cells.forEach(function (cell) { cell.disabled = true; });
    updateTurnPills();
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = winner === 'draw' ? "It's a Draw!" : (winner === 'X' ? 'You Win!' : 'Friend Wins!');
    card.insertBefore(banner, resetBtn);
  }

  cells.forEach(function (cell) {
    cell.addEventListener('click', function () {
      var i = parseInt(cell.dataset.i, 10);
      if (over || state[i]) return;
      state[i] = turn;
      cell.textContent = turn;
      cell.dataset.mark = turn;
      var winner = checkWinner();
      if (winner) {
        endGame(winner);
        return;
      }
      turn = turn === 'X' ? 'O' : 'X';
      updateTurnPills();
    });
  });

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
