// Student Portal > Vocabulary - client-side round runner. The word
// list itself (VOCABULARY_ROUND, grade-level-appropriate) is rendered
// server-side by views/student-vocabulary.ejs since it depends on the
// signed-in student's own member record; this file just drives one
// clue-at-a-time round and reports the final score at the end.
(function () {
  var progressEl = document.getElementById('vg-progress');
  var clueEl = document.getElementById('vg-clue');
  var input = document.getElementById('vg-input');
  var feedbackEl = document.getElementById('vg-feedback');
  var submitBtn = document.getElementById('vg-submit');
  var card = document.getElementById('vg-card');
  var resultCard = document.getElementById('vg-result');
  var resultText = document.getElementById('vg-result-text');
  var againBtn = document.getElementById('vg-again');
  if (!progressEl || !window.VOCABULARY_ROUND || !window.VOCABULARY_ROUND.length) return;

  var round = window.VOCABULARY_ROUND;
  var index, correct, locked;

  function start() {
    index = 0;
    correct = 0;
    locked = false;
    card.hidden = false;
    resultCard.hidden = true;
    showWord();
  }

  function showWord() {
    var item = round[index];
    progressEl.textContent = 'Word ' + (index + 1) + ' / ' + round.length;
    clueEl.textContent = item.clue;
    input.value = '';
    input.disabled = false;
    feedbackEl.textContent = '';
    feedbackEl.className = 'vocabulary-game-feedback';
    input.focus();
  }

  function submit() {
    if (locked) return;
    var item = round[index];
    var typed = input.value.trim().toLowerCase();
    var ok = typed === item.word.toLowerCase();
    if (ok) correct += 1;
    feedbackEl.textContent = ok ? 'Correct!' : 'Not quite - the word is "' + item.word + '".';
    feedbackEl.className = 'vocabulary-game-feedback ' + (ok ? 'vocabulary-game-feedback-correct' : 'vocabulary-game-feedback-wrong');
    input.disabled = true;
    locked = true;
    setTimeout(function () {
      locked = false;
      index += 1;
      if (index >= round.length) return finish();
      showWord();
    }, 1100);
  }

  function finish() {
    card.hidden = true;
    resultCard.hidden = false;
    resultText.textContent = 'You got ' + correct + ' out of ' + round.length + ' words correct!';
    fetch('/student/vocabulary/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      body: JSON.stringify({ correctCount: correct, roundTotal: round.length }),
      keepalive: true,
    }).catch(function () {});
  }

  submitBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  againBtn.addEventListener('click', start);

  start();
})();
