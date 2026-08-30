// Student Portal > Games > Word Scramble - unscramble the letters to
// spell the word. Reports the final score to /student/games/score.
(function () {
  var card = document.getElementById('scramble-card');
  if (!card) return;
  var scoreEl = document.getElementById('scramble-score');
  var scrambledEl = document.getElementById('scramble-word');
  var input = document.getElementById('scramble-input');
  var feedbackEl = document.getElementById('scramble-feedback');
  var submitBtn = document.getElementById('scramble-submit');
  var resetBtn = document.getElementById('scramble-reset');

  var WORDS = ['apple', 'garden', 'forest', 'river', 'mountain', 'sunshine', 'rainbow', 'thunder', 'meadow', 'ocean', 'breeze', 'autumn'];

  var order, index, score, locked;

  function shuffle(arr) {
    var copy = arr.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
    }
    return copy;
  }

  function scrambleWord(word) {
    var letters;
    do {
      letters = shuffle(word.split(''));
    } while (letters.join('') === word && word.length > 1);
    return letters.join('').toUpperCase();
  }

  function newGame() {
    order = shuffle(WORDS).slice(0, 8);
    index = 0; score = 0; locked = false;
    showWord();
  }

  function showWord() {
    if (index >= order.length) {
      scrambledEl.textContent = 'Done!';
      feedbackEl.textContent = 'Score: ' + score + ' / ' + order.length;
      feedbackEl.className = 'spelling-bee-feedback';
      input.disabled = true;
      scoreEl.textContent = String(score);
      if (typeof window.reportGameScore === 'function') window.reportGameScore('word-scramble', score);
      return;
    }
    scoreEl.textContent = String(score);
    scrambledEl.textContent = scrambleWord(order[index]);
    input.value = '';
    input.disabled = false;
    feedbackEl.textContent = '';
    feedbackEl.className = 'spelling-bee-feedback';
    input.focus();
  }

  function submit() {
    if (locked || index >= order.length) return;
    var word = order[index];
    var ok = input.value.trim().toLowerCase() === word;
    if (ok) score += 1;
    feedbackEl.textContent = ok ? 'Correct!' : 'It was "' + word + '".';
    feedbackEl.className = 'spelling-bee-feedback ' + (ok ? 'spelling-bee-feedback-correct' : 'spelling-bee-feedback-wrong');
    input.disabled = true;
    locked = true;
    setTimeout(function () { locked = false; index += 1; showWord(); }, 1000);
  }

  submitBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  resetBtn.addEventListener('click', newGame);
  newGame();
})();
