// Student Portal > Games - shared helper the 4 score-reporting games
// (snake.js, avoid-obstacles.js, trivia.js, typing-race.js) call when a
// round ends, POSTing to routes/student-portal.js's own /games/score so
// the header stats bar's "High Score" can reflect it. Fire-and-forget:
// a logged-out/expired session or a network hiccup just means this
// round's score doesn't get recorded, never something worth blocking or
// erroring the game over.
window.reportGameScore = function (key, score) {
  fetch('/student/games/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
    body: JSON.stringify({ key: key, score: score }),
    keepalive: true,
  }).catch(function () {});
};
