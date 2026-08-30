// Student Portal > Games > Riddle Rush - a round of riddles, pick the
// right answer as fast as you can. Reports the final score (same shape
// as trivia.js) to /student/games/score at the end.
(function () {
  var card = document.getElementById('riddle-card');
  if (!card) return;
  var scoreEl = document.getElementById('riddle-score');
  var riddleEl = document.getElementById('riddle-text');
  var choicesEl = document.getElementById('riddle-choices');
  var resetBtn = document.getElementById('riddle-reset');

  var RIDDLES = [
    { q: 'What has keys but cannot open a single lock?', c: ['A piano', 'A map', 'A treasure chest', 'A door'], a: 0 },
    { q: 'What has to be broken before you can use it?', c: ['A rule', 'An egg', 'A promise', 'A window'], a: 1 },
    { q: 'I speak without a mouth and hear without ears. What am I?', c: ['A ghost', 'A phone', 'An echo', 'A shadow'], a: 2 },
    { q: 'What month of the year has 28 days?', c: ['February', 'All of them', 'April', 'None of them'], a: 1 },
    { q: 'What gets wetter as it dries?', c: ['A sponge', 'A towel', 'Rain', 'A puddle'], a: 1 },
    { q: 'What has a neck but no head?', c: ['A shirt', 'A guitar', 'A bottle', 'A snake'], a: 2 },
    { q: 'What can travel around the world while staying in a corner?', c: ['A stamp', 'A map', 'The wind', 'A satellite'], a: 0 },
    { q: 'What has one eye but cannot see?', c: ['A cyclops', 'A needle', 'A storm', 'A camera'], a: 1 },
    { q: 'What goes up but never comes down?', c: ['A balloon', 'A rocket', 'Your age', 'Smoke'], a: 2 },
    { q: 'What has many teeth but cannot bite?', c: ['A comb', 'A shark', 'A saw', 'A zipper'], a: 0 },
  ];

  var order, index, score;

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function newGame() {
    order = shuffle(RIDDLES.map(function (_, i) { return i; }));
    index = 0; score = 0;
    showRiddle();
  }

  function showRiddle() {
    if (index >= order.length) {
      riddleEl.textContent = 'Round complete! Score: ' + score + ' / ' + order.length;
      choicesEl.innerHTML = '';
      scoreEl.textContent = String(score);
      if (typeof window.reportGameScore === 'function') window.reportGameScore('riddle-rush', score);
      return;
    }
    var item = RIDDLES[order[index]];
    scoreEl.textContent = String(score);
    riddleEl.textContent = item.q;
    choicesEl.innerHTML = '';
    item.c.forEach(function (choice, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trivia-choice-btn';
      btn.textContent = choice;
      btn.addEventListener('click', function () { answer(i, btn, item); });
      choicesEl.appendChild(btn);
    });
  }

  function answer(i, btn, item) {
    Array.from(choicesEl.children).forEach(function (b) { b.disabled = true; });
    if (i === item.a) { btn.classList.add('trivia-choice-correct'); score += 1; }
    else { btn.classList.add('trivia-choice-wrong'); choicesEl.children[item.a].classList.add('trivia-choice-correct'); }
    setTimeout(function () { index += 1; showRiddle(); }, 900);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
