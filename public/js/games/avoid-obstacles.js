// Student Portal > Games > Avoid the Obstacles - top-down endless driving
// game, dodge scrolling obstacles with arrow keys or the on-screen d-pad.
(function () {
  var canvas = document.getElementById('drive-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('drive-score');
  var resetBtn = document.getElementById('drive-reset');
  var card = document.getElementById('drive-card');

  var W = canvas.width, H = canvas.height;
  var LANES = 3, LANE_W = W / LANES;
  var CAR_W = LANE_W - 14, CAR_H = 22;

  var lane, obstacles, speed, score, over, spawnTimer, raf, lastTime, banner;

  function newGame() {
    lane = 1;
    obstacles = [];
    speed = 1.6;
    score = 0;
    over = false;
    spawnTimer = 0;
    lastTime = performance.now();
    scoreEl.textContent = '0';
    if (banner) { banner.remove(); banner = null; }
    if (raf) cancelAnimationFrame(raf);
    loop(lastTime);
  }

  function move(dir) {
    if (over) return;
    lane = Math.max(0, Math.min(LANES - 1, lane + dir));
  }

  function loop(now) {
    if (over) return;
    var dt = now - lastTime;
    lastTime = now;

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = Math.max(420, 900 - score * 4);
      obstacles.push({ lane: Math.floor(Math.random() * LANES), y: -CAR_H });
    }
    obstacles.forEach(function (o) { o.y += speed * (dt / 16); });
    obstacles = obstacles.filter(function (o) { return o.y < H + CAR_H; });

    var carY = H - CAR_H - 8;
    var carX = lane * LANE_W + 7;
    var hit = obstacles.some(function (o) {
      var ox = o.lane * LANE_W + 7;
      return o.lane === lane && o.y + CAR_H > carY && o.y < carY + CAR_H && Math.abs(ox - carX) < CAR_W;
    });
    if (hit) return endGame();

    score += dt / 100;
    scoreEl.textContent = String(Math.floor(score));
    speed += dt * 0.00006;

    draw(carX, carY);
    raf = requestAnimationFrame(loop);
  }

  function draw(carX, carY) {
    ctx.fillStyle = '#334155';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([6, 8]);
    for (var i = 1; i < LANES; i++) {
      ctx.beginPath();
      ctx.moveTo(i * LANE_W, 0);
      ctx.lineTo(i * LANE_W, H);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#dc2626';
    obstacles.forEach(function (o) {
      ctx.fillRect(o.lane * LANE_W + 7, o.y, CAR_W, CAR_H);
    });
    ctx.fillStyle = '#4ade80';
    ctx.fillRect(carX, carY, CAR_W, CAR_H);
  }

  function endGame() {
    over = true;
    if (raf) cancelAnimationFrame(raf);
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = 'Crashed! Score: ' + Math.floor(score);
    card.insertBefore(banner, resetBtn);
    if (typeof window.reportGameScore === 'function') window.reportGameScore('avoid-obstacles', Math.floor(score));
  }

  document.addEventListener('keydown', function (e) {
    if (!document.body.contains(canvas)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
  });

  card.querySelectorAll('.game-dpad-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { move(btn.dataset.dir === 'left' ? -1 : 1); });
  });

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
