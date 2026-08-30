// Student Portal > Spelling Bee - client-side round runner. The word
// list itself (SPELLING_ROUND, grade-level-appropriate) is rendered
// server-side by views/student-spelling-bee.ejs since it depends on the
// signed-in student's own member record; this file just drives one
// clue-at-a-time round and reports the final score at the end.
(function () {
  var progressEl = document.getElementById('sb-progress');
  var clueEl = document.getElementById('sb-clue');
  var input = document.getElementById('sb-input');
  var feedbackEl = document.getElementById('sb-feedback');
  var submitBtn = document.getElementById('sb-submit');
  var card = document.getElementById('sb-card');
  var resultCard = document.getElementById('sb-result');
  var resultText = document.getElementById('sb-result-text');
  var againBtn = document.getElementById('sb-again');
  if (!progressEl || !window.SPELLING_ROUND || !window.SPELLING_ROUND.length) return;

  var round = window.SPELLING_ROUND;
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
    feedbackEl.className = 'spelling-bee-feedback';
    input.focus();
  }

  function submit() {
    if (locked) return;
    var item = round[index];
    var typed = input.value.trim().toLowerCase();
    var ok = typed === item.word.toLowerCase();
    if (ok) correct += 1;
    feedbackEl.textContent = ok ? 'Correct!' : 'Not quite - it\'s spelled "' + item.word + '".';
    feedbackEl.className = 'spelling-bee-feedback ' + (ok ? 'spelling-bee-feedback-correct' : 'spelling-bee-feedback-wrong');
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
    resultText.textContent = 'You spelled ' + correct + ' out of ' + round.length + ' words correctly!';
    fetch('/student/spelling-bee/score', {
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
