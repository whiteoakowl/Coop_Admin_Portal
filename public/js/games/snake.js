// Student Portal > Games > Snake - classic canvas snake, arrow keys/WASD
// or the on-screen d-pad, local single-player only.
(function () {
  var canvas = document.getElementById('snake-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('snake-score');
  var resetBtn = document.getElementById('snake-reset');
  var card = document.getElementById('snake-card');

  var COLS = 16, ROWS = 16, CELL = canvas.width / COLS;
  var snake, dir, nextDir, food, score, over, timer, banner;

  function randCell() {
    return { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  }

  function placeFood() {
    var cell;
    do { cell = randCell(); } while (snake.some(function (s) { return s.x === cell.x && s.y === cell.y; }));
    food = cell;
  }

  function newGame() {
    snake = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
    dir = { x: 0, y: 0 };
    nextDir = dir;
    score = 0;
    over = false;
    scoreEl.textContent = '0';
    if (banner) { banner.remove(); banner = null; }
    placeFood();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 150);
    draw();
  }

  function setDir(x, y) {
    if (dir.x === -x && dir.y === -y) return;
    nextDir = { x: x, y: y };
  }

  // A real bug: the snake used to start already moving right, so a
  // player who hadn't reacted within ~1.2s (8 cells at 150ms/tick) hit
  // the wall and saw "Game Over" almost immediately - reported as "the
  // game freezes and doesn't keep moving." Waiting for the first
  // direction input before ticking at all matches how every other
  // Snake clone starts and gives the player time to get oriented.
  // Wraps off any edge instead of dying there - a real request: "snake
  // should be able to go through walls, like the Nokia phone game."
  // Self-collision is still a real death; only the four board edges wrap.
  function tick() {
    if (over || (dir.x === 0 && dir.y === 0 && nextDir.x === 0 && nextDir.y === 0)) return;
    dir = nextDir;
    var head = { x: (snake[0].x + dir.x + COLS) % COLS, y: (snake[0].y + dir.y + ROWS) % ROWS };
    if (snake.some(function (s) { return s.x === head.x && s.y === head.y; })) {
      return endGame();
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score += 10;
      scoreEl.textContent = String(score);
      placeFood();
    } else {
      snake.pop();
    }
    draw();
  }

  function draw() {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(food.x * CELL + 1, food.y * CELL + 1, CELL - 2, CELL - 2);
    snake.forEach(function (s, i) {
      ctx.fillStyle = i === 0 ? '#4ade80' : '#16a34a';
      ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
    });
  }

  function endGame() {
    over = true;
    clearInterval(timer);
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = 'Game Over! Score: ' + score;
    card.insertBefore(banner, resetBtn);
    if (typeof window.reportGameScore === 'function') window.reportGameScore('snake', score);
  }

  document.addEventListener('keydown', function (e) {
    if (!document.body.contains(canvas)) return;
    var map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
    var v = map[e.key];
    if (!v) return;
    e.preventDefault();
    setDir(v[0], v[1]);
  });

  card.querySelectorAll('.game-dpad-btn').forEach(function (btn) {
    var map = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    btn.addEventListener('click', function () { var v = map[btn.dataset.dir]; setDir(v[0], v[1]); });
  });

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
