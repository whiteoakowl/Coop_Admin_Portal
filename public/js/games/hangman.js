// Student Portal > Games > Hangman - word + category list, on-screen
// QWERTY keyboard, 5 wrong guesses before the gallows figure is
// complete (see views/student-games.ejs's own header comment).
(function () {
  var wordEl = document.getElementById('hangman-word');
  if (!wordEl) return;
  var categoryEl = document.getElementById('hangman-category');
  var dotsEl = document.getElementById('hangman-guess-dots');
  var keyboardEl = document.getElementById('hangman-keyboard');
  var resetBtn = document.getElementById('hangman-reset');
  var card = document.getElementById('hangman-card');
  var parts = ['hangman-head', 'hangman-body', 'hangman-arm-l', 'hangman-arm-r', 'hangman-leg-l', 'hangman-leg-r'].map(function (id) {
    return document.getElementById(id);
  });

  var MAX_WRONG = 5;
  var WORDS = [
    { word: 'PANDA', category: 'Animals' },
    { word: 'DOLPHIN', category: 'Animals' },
    { word: 'GIRAFFE', category: 'Animals' },
    { word: 'FRACTION', category: 'Math' },
    { word: 'TRIANGLE', category: 'Math' },
    { word: 'VOLCANO', category: 'Science' },
    { word: 'GRAVITY', category: 'Science' },
    { word: 'LIBRARY', category: 'School' },
    { word: 'PENCIL', category: 'School' },
    { word: 'RAINBOW', category: 'Nature' },
  ];

  var word, category, guessed, wrongCount, over;
  var banner = null;

  function newGame() {
    var pick = WORDS[Math.floor(Math.random() * WORDS.length)];
    word = pick.word;
    category = pick.category;
    guessed = new Set();
    wrongCount = 0;
    over = false;
    categoryEl.textContent = category;
    if (banner) { banner.remove(); banner = null; }
    renderKeyboard();
    render();
  }

  function renderKeyboard() {
    keyboardEl.innerHTML = '';
    ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'].forEach(function (rowLetters) {
      var row = document.createElement('div');
      row.className = 'hangman-keyboard-row';
      rowLetters.split('').forEach(function (letter) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hangman-key';
        btn.textContent = letter;
        btn.dataset.letter = letter;
        btn.addEventListener('click', function () { guess(letter); });
        row.appendChild(btn);
      });
      keyboardEl.appendChild(row);
    });
  }

  function render() {
    wordEl.textContent = word
      .split('')
      .map(function (letter) { return guessed.has(letter) ? letter : '_'; })
      .join(' ');

    dotsEl.innerHTML = '';
    for (var i = 0; i < MAX_WRONG; i++) {
      var dot = document.createElement('span');
      dot.className = 'hangman-guess-dot' + (i < wrongCount ? ' hangman-guess-dot-wrong' : '');
      if (i < wrongCount) dot.textContent = '✕';
      dotsEl.appendChild(dot);
    }

    // SVGElement doesn't reliably reflect the `.hidden` IDL property to
    // the actual `hidden` content attribute the way HTMLElement does
    // (see views/student-pets-customize.ejs's own comment on the same
    // bug) - these gallows parts are SVG circle/line elements, so use
    // setAttribute/removeAttribute instead of the `.hidden` property.
    parts.forEach(function (part, i) {
      if (i >= wrongCount) part.setAttribute('hidden', '');
      else part.removeAttribute('hidden');
    });
  }

  function guess(letter) {
    if (over || guessed.has(letter)) return;
    guessed.add(letter);
    var key = keyboardEl.querySelector('[data-letter="' + letter + '"]');
    if (word.indexOf(letter) === -1) {
      wrongCount += 1;
      if (key) { key.disabled = true; key.classList.add('hangman-key-wrong'); }
    } else if (key) {
      key.disabled = true;
      key.classList.add('hangman-key-correct');
    }
    render();

    var solved = word.split('').every(function (letter) { return guessed.has(letter); });
    if (solved) return endGame(true);
    if (wrongCount >= MAX_WRONG) return endGame(false);
  }

  function endGame(won) {
    over = true;
    keyboardEl.querySelectorAll('.hangman-key').forEach(function (key) { key.disabled = true; });
    if (!won) wordEl.textContent = word.split('').join(' ');
    banner = document.createElement('div');
    banner.className = 'game-win-banner';
    banner.textContent = won ? 'You Got It!' : 'Out of Guesses - the word was ' + word;
    card.insertBefore(banner, resetBtn);
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
