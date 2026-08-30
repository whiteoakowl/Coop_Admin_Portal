// Student Portal > Games > Pong - you (left paddle, mouse/touch/arrow
// keys or the on-screen d-pad) vs a simple computer paddle, first to 5.
(function () {
  var canvas = document.getElementById('pong-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('pong-score');
  var resetBtn = document.getElementById('pong-reset');
  var card = document.getElementById('pong-card');

  var W = canvas.width, H = canvas.height;
  var PADDLE_W = 6, PADDLE_H = 26, WIN_SCORE = 5;
  var youY, cpuY, ballX, ballY, ballVX, ballVY, youScore, cpuScore, over, raf, banner;

  function newGame() {
    youY = H / 2 - PADDLE_H / 2;
    cpuY = H / 2 - PADDLE_H / 2;
    resetBall();
    youScore = 0; cpuScore = 0; over = false;
    scoreEl.textContent = '0 - 0';
    if (banner) { banner.remove(); banner = null; }
    if (raf) cancelAnimationFrame(raf);
    loop();
  }

  function resetBall() {
    ballX = W / 2; ballY = H / 2;
    ballVX = (Math.random() < 0.5 ? -1 : 1) * 1.6;
    ballVY = (Math.random() * 2 - 1) * 1.4;
  }

  function moveYou(delta) {
    youY = Math.max(0, Math.min(H - PADDLE_H, youY + delta));
  }

  function loop() {
    if (over) return;
    cpuY += Math.sign((ballY - (cpuY + PADDLE_H / 2))) * 1.4;
    cpuY = Math.max(0, Math.min(H - PADDLE_H, cpuY));

    ballX += ballVX; ballY += ballVY;
    if (ballY <= 0 || ballY >= H) ballVY *= -1;

    if (ballX <= PADDLE_W + 2 && ballY >= youY && ballY <= youY + PADDLE_H) {
      ballVX = Math.abs(ballVX) * 1.05;
      ballVY += (ballY - (youY + PADDLE_H / 2)) * 0.08;
    }
    if (ballX >= W - PADDLE_W - 2 && ballY >= cpuY && ballY <= cpuY + PADDLE_H) {
      ballVX = -Math.abs(ballVX) * 1.05;
      ballVY += (ballY - (cpuY + PADDLE_H / 2)) * 0.08;
    }

    if (ballX < 0) { cpuScore += 1; scoreCheck(); resetBall(); }
    if (ballX > W) { youScore += 1; scoreCheck(); resetBall(); }

    draw();
    raf = requestAnimationFrame(loop);
  }

  function scoreCheck() {
    scoreEl.textContent = youScore + ' - ' + cpuScore;
    if (youScore >= WIN_SCORE || cpuScore >= WIN_SCORE) endGame(youScore > cpuScore);
  }

  function draw() {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(2, youY, PADDLE_W, PADDLE_H);
    ctx.fillRect(W - PADDLE_W - 2, cpuY, PADDLE_W, PADDLE_H);
    ctx.beginPath();
    ctx.arc(ballX, ballY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function endGame(won) {
    over = true;
    if (raf) cancelAnimationFrame(raf);
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = won ? 'You win!' : 'Computer wins!';
    card.insertBefore(banner, resetBtn);
  }

  canvas.addEventListener('mousemove', function (e) {
    var rect = canvas.getBoundingClientRect();
    moveYou(((e.clientY - rect.top) * (H / rect.height)) - youY - PADDLE_H / 2);
  });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var t = e.touches[0];
    moveYou(((t.clientY - rect.top) * (H / rect.height)) - youY - PADDLE_H / 2);
  }, { passive: false });

  document.addEventListener('keydown', function (e) {
    if (!document.body.contains(canvas)) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveYou(-12); }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveYou(12); }
  });

  card.querySelectorAll('.game-dpad-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { moveYou(btn.dataset.dir === 'up' ? -16 : 16); });
  });

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
