// Student Portal > Games > Typing Race - type the sentence shown as
// fast and accurately as you can; reports WPM + accuracy when done.
(function () {
  var target = document.getElementById('typing-target');
  if (!target) return;
  var input = document.getElementById('typing-input');
  var resultEl = document.getElementById('typing-result');
  var resetBtn = document.getElementById('typing-reset');

  var SENTENCES = [
    'The quick brown fox jumps over the lazy dog.',
    'Learning today, leading tomorrow.',
    'Practice makes progress, not perfection.',
    'Reading opens the door to new worlds.',
    'Every expert was once a beginner.',
    'Great things take time and patience.',
    'Curiosity is the engine of achievement.',
  ];

  var sentence, startTime, done;

  function newGame(focusInput) {
    sentence = SENTENCES[Math.floor(Math.random() * SENTENCES.length)];
    startTime = null;
    done = false;
    input.value = '';
    input.disabled = false;
    resultEl.textContent = '';
    renderTarget('');
    // Only steal focus (and the scroll-into-view a browser does for
    // that) when the player explicitly clicked "New Sentence" - doing it
    // on the initial page-load call yanked the whole page down to
    // whichever row this card landed on (a real bug: every visit to
    // /student/games silently auto-scrolled the mobile page away from
    // the top, past every earlier game).
    if (focusInput) input.focus();
  }

  function renderTarget(typed) {
    var html = '';
    for (var i = 0; i < sentence.length; i++) {
      var ch = sentence[i];
      var cls = i >= typed.length ? '' : (typed[i] === ch ? 'typing-char-correct' : 'typing-char-wrong');
      html += '<span class="' + cls + '">' + ch.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>';
    }
    target.innerHTML = html;
  }

  input.addEventListener('input', function () {
    if (done) return;
    if (!startTime) startTime = Date.now();
    var typed = input.value;
    renderTarget(typed);
    if (typed === sentence) {
      done = true;
      input.disabled = true;
      var seconds = (Date.now() - startTime) / 1000;
      var words = sentence.split(' ').length;
      var wpm = Math.round((words / seconds) * 60);
      resultEl.textContent = wpm + ' WPM • ' + seconds.toFixed(1) + 's • 100% accuracy';
      if (typeof window.reportGameScore === 'function') window.reportGameScore('typing-race', wpm);
    }
  });

  resetBtn.addEventListener('click', function () { newGame(true); });
  newGame(false);
})();
