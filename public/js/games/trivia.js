// Student Portal > Games > Trivia Quiz - pick an age level, answer
// multiple-choice questions from that level's bank, see a final score.
(function () {
  var card = document.getElementById('trivia-card');
  if (!card) return;
  var levelRow = document.getElementById('trivia-levels');
  var box = document.getElementById('trivia-question-box');
  var scoreEl = document.getElementById('trivia-score');
  var questionEl = document.getElementById('trivia-question');
  var choicesEl = document.getElementById('trivia-choices');
  var resetBtn = document.getElementById('trivia-reset');

  var BANKS = {
    k2: [
      { q: 'What color do you get mixing blue and yellow?', c: ['Green', 'Purple', 'Orange', 'Pink'], a: 0 },
      { q: 'How many days are in a week?', c: ['5', '6', '7', '8'], a: 2 },
      { q: 'What sound does a cow make?', c: ['Moo', 'Woof', 'Meow', 'Oink'], a: 0 },
      { q: 'Which shape has 3 sides?', c: ['Square', 'Triangle', 'Circle', 'Hexagon'], a: 1 },
      { q: 'What do bees make?', c: ['Milk', 'Honey', 'Bread', 'Juice'], a: 1 },
      { q: '2 + 3 = ?', c: ['4', '5', '6', '7'], a: 1 },
    ],
    '35': [
      { q: 'What is the capital of the United States?', c: ['New York', 'Washington, D.C.', 'Chicago', 'Boston'], a: 1 },
      { q: 'Which planet is known as the Red Planet?', c: ['Earth', 'Mars', 'Jupiter', 'Saturn'], a: 1 },
      { q: '7 x 8 = ?', c: ['54', '56', '64', '48'], a: 1 },
      { q: 'What is the largest ocean on Earth?', c: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], a: 3 },
      { q: 'How many continents are there?', c: ['5', '6', '7', '8'], a: 2 },
      { q: 'What gas do plants absorb from the air?', c: ['Oxygen', 'Carbon Dioxide', 'Nitrogen', 'Helium'], a: 1 },
    ],
    '68': [
      { q: 'What is the chemical symbol for gold?', c: ['Ag', 'Au', 'Gd', 'Go'], a: 1 },
      { q: 'Who wrote "Romeo and Juliet"?', c: ['Charles Dickens', 'Mark Twain', 'William Shakespeare', 'Jane Austen'], a: 2 },
      { q: 'What is the square root of 144?', c: ['11', '12', '13', '14'], a: 1 },
      { q: 'Which country hosted the 2016 Summer Olympics?', c: ['China', 'UK', 'Brazil', 'Japan'], a: 2 },
      { q: 'What is the powerhouse of the cell?', c: ['Nucleus', 'Ribosome', 'Mitochondria', 'Cytoplasm'], a: 2 },
      { q: 'In what year did World War II end?', c: ['1943', '1945', '1947', '1950'], a: 1 },
    ],
  };

  var questions, index, score;

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function startLevel(level) {
    questions = shuffle(BANKS[level].slice());
    index = 0; score = 0;
    levelRow.hidden = true;
    box.hidden = false;
    resetBtn.textContent = 'Change Level';
    showQuestion();
  }

  function showQuestion() {
    if (index >= questions.length) {
      scoreEl.textContent = 'Final Score: ' + score + ' / ' + questions.length;
      questionEl.textContent = score === questions.length ? 'Perfect score! 🎉' : 'Nice work!';
      choicesEl.innerHTML = '';
      if (typeof window.reportGameScore === 'function') window.reportGameScore('trivia', score);
      return;
    }
    var item = questions[index];
    scoreEl.textContent = 'Question ' + (index + 1) + ' / ' + questions.length + ' • Score: ' + score;
    questionEl.textContent = item.q;
    choicesEl.innerHTML = '';
    item.c.forEach(function (choice, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trivia-choice-btn';
      btn.textContent = choice;
      btn.addEventListener('click', function () { answer(i, btn); });
      choicesEl.appendChild(btn);
    });
  }

  function answer(i, btn) {
    var item = questions[index];
    Array.from(choicesEl.children).forEach(function (b) { b.disabled = true; });
    if (i === item.a) {
      btn.classList.add('trivia-choice-correct');
      score += 1;
    } else {
      btn.classList.add('trivia-choice-wrong');
      choicesEl.children[item.a].classList.add('trivia-choice-correct');
    }
    setTimeout(function () { index += 1; showQuestion(); }, 900);
  }

  levelRow.querySelectorAll('.trivia-level-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { startLevel(btn.dataset.level); });
  });

  resetBtn.addEventListener('click', function () {
    levelRow.hidden = false;
    box.hidden = true;
    resetBtn.textContent = 'Change Level';
  });
})();
