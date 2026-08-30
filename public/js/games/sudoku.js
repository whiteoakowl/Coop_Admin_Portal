// Student Portal > Games > Sudoku - generates a random valid 9x9 puzzle
// (full solution via randomized backtracking, then cells removed for the
// puzzle), select a cell then tap a number to fill it in.
(function () {
  var grid = document.getElementById('sudoku-grid');
  if (!grid) return;
  var padEl = document.getElementById('sudoku-pad');
  var resetBtn = document.getElementById('sudoku-reset');
  var card = document.getElementById('sudoku-card');

  var solution, puzzle, given, cellEls, selected, banner;

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function validAt(board, r, c, v) {
    for (var i = 0; i < 9; i++) {
      if (board[r][i] === v || board[i][c] === v) return false;
    }
    var br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
    for (var y = br; y < br + 3; y++) {
      for (var x = bc; x < bc + 3; x++) {
        if (board[y][x] === v) return false;
      }
    }
    return true;
  }

  function fillBoard(board, pos) {
    if (pos === 81) return true;
    var r = Math.floor(pos / 9), c = pos % 9;
    var nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (var i = 0; i < nums.length; i++) {
      if (validAt(board, r, c, nums[i])) {
        board[r][c] = nums[i];
        if (fillBoard(board, pos + 1)) return true;
        board[r][c] = 0;
      }
    }
    return false;
  }

  function generate() {
    var board = [];
    for (var i = 0; i < 9; i++) board.push(new Array(9).fill(0));
    fillBoard(board, 0);
    solution = board;
    puzzle = board.map(function (row) { return row.slice(); });
    given = board.map(function (row) { return row.map(function () { return true; }); });

    var cellsToRemove = 42;
    var coords = shuffle(Array.from({ length: 81 }, function (_, i) { return i; }));
    for (var k = 0; k < cellsToRemove && k < coords.length; k++) {
      var r = Math.floor(coords[k] / 9), c = coords[k] % 9;
      puzzle[r][c] = 0;
      given[r][c] = false;
    }
  }

  function newGame() {
    generate();
    selected = null;
    if (banner) { banner.remove(); banner = null; }
    grid.innerHTML = '';
    cellEls = [];
    for (var r = 0; r < 9; r++) {
      var rowEls = [];
      for (var c = 0; c < 9; c++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sudoku-cell';
        if ((Math.floor(r / 3) + Math.floor(c / 3)) % 2 === 1) btn.classList.add('sudoku-cell-shade');
        if (given[r][c]) { btn.textContent = String(puzzle[r][c]); btn.classList.add('sudoku-cell-given'); }
        btn.addEventListener('click', function (r, c) { return function () { select(r, c); }; }(r, c));
        grid.appendChild(btn);
        rowEls.push(btn);
      }
      cellEls.push(rowEls);
    }
  }

  function select(r, c) {
    if (given[r][c]) return;
    if (selected) cellEls[selected[0]][selected[1]].classList.remove('sudoku-cell-selected');
    selected = [r, c];
    cellEls[r][c].classList.add('sudoku-cell-selected');
  }

  function place(v) {
    if (!selected) return;
    var r = selected[0], c = selected[1];
    puzzle[r][c] = v;
    var el = cellEls[r][c];
    el.textContent = v === 0 ? '' : String(v);
    el.classList.toggle('sudoku-cell-wrong', v !== 0 && v !== solution[r][c]);
    if (v !== 0 && checkWin()) endGame();
  }

  function checkWin() {
    for (var r = 0; r < 9; r++) {
      for (var c = 0; c < 9; c++) {
        if (puzzle[r][c] !== solution[r][c]) return false;
      }
    }
    return true;
  }

  function endGame() {
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = 'Puzzle solved! 🎉';
    card.insertBefore(banner, resetBtn);
  }

  padEl.querySelectorAll('.sudoku-pad-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { place(parseInt(btn.dataset.v, 10)); });
  });

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
