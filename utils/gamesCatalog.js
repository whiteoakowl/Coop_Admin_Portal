// Student Portal > Games catalog - the single source of truth for the
// preview grid (/student/games) and the per-game play page
// (/student/games/play/:key). Each entry's `key` doubles as the
// views/partials/games/<key>.ejs partial name and is validated against
// that filename in the route, so an unknown key 404s instead of
// rendering an empty page.
//
// `preview` is a small trusted HTML snippet (built only from the
// `.mini-*` helper classes in styles.css) rendered unescaped inside the
// tile's colored preview box - a real request: "correct the image
// example on each card to look like partial versions of each game"
// after an earlier pass used one big static emoji per tile instead of
// something that reads as an in-progress screenshot.
const GAMES = [
  {
    key: 'tic-tac-toe', title: 'Tic Tac Toe', tagline: 'Play against a friend', category: 'classic', accent: 'purple', script: 'tictactoe.js',
    preview: `<div class="mini-grid mini-grid-3">
      <span class="mini-cell mini-cell-on mini-cell-x">✕</span><span class="mini-cell"></span><span class="mini-cell mini-cell-on mini-cell-o">○</span>
      <span class="mini-cell"></span><span class="mini-cell mini-cell-on mini-cell-x">✕</span><span class="mini-cell"></span>
      <span class="mini-cell mini-cell-on mini-cell-o">○</span><span class="mini-cell"></span><span class="mini-cell"></span>
    </div>`,
  },
  {
    key: 'hangman', title: 'Hangman', tagline: 'Can you guess the word?', category: 'word', accent: 'yellow', script: 'hangman.js',
    preview: `<div class="mini-stack">
      <span class="mini-word">_ A _ G _ A _</span>
      <span class="mini-row"><span class="mini-key">A</span><span class="mini-key">B</span><span class="mini-key mini-key-off">C</span><span class="mini-key mini-key-off">D</span></span>
    </div>`,
  },
  {
    key: 'connect-four', title: 'Connect Four', tagline: 'Be the first to connect 4!', category: 'classic', accent: 'blue', script: 'connect-four.js',
    preview: `<div class="mini-grid mini-grid-4 mini-c4">
      <span class="mini-dot"></span><span class="mini-dot mini-dot-y"></span><span class="mini-dot"></span><span class="mini-dot mini-dot-r"></span>
      <span class="mini-dot mini-dot-r"></span><span class="mini-dot mini-dot-y"></span><span class="mini-dot"></span><span class="mini-dot mini-dot-y"></span>
    </div>`,
  },
  {
    key: 'memory-match', title: 'Memory Match', tagline: 'Find every matching pair', category: 'puzzle', accent: 'purple', script: 'matching.js',
    preview: `<div class="mini-grid mini-grid-3">
      <span class="mini-cell mini-cell-on">⭐</span><span class="mini-cell"></span><span class="mini-cell mini-cell-on">☀️</span>
      <span class="mini-cell"></span><span class="mini-cell mini-cell-on">⭐</span><span class="mini-cell"></span>
    </div>`,
  },
  {
    key: 'trivia', title: 'Trivia Quiz', tagline: 'Test your knowledge, 3 levels', category: 'trivia', accent: 'red', script: 'trivia.js',
    preview: `<div class="mini-stack">
      <span class="mini-label">Which planet is red?</span>
      <span class="mini-bar mini-bar-on"></span>
      <span class="mini-bar"></span>
    </div>`,
  },
  {
    key: 'snake', title: 'Snake', tagline: "Eat, grow, don't crash", category: 'arcade', accent: 'dark', script: 'snake.js',
    preview: `<div class="mini-snake">
      <span class="mini-snake-seg" style="top:42%;left:16%;"></span>
      <span class="mini-snake-seg" style="top:42%;left:29%;"></span>
      <span class="mini-snake-seg" style="top:42%;left:42%;"></span>
      <span class="mini-dot mini-dot-r mini-snake-food" style="top:40%;left:66%;"></span>
    </div>`,
  },
  {
    key: 'minesweeper', title: 'Minesweeper', tagline: 'Clear the board safely', category: 'puzzle', accent: 'gray', script: 'minesweeper.js',
    preview: `<div class="mini-grid mini-grid-4">
      <span class="mini-cell mini-cell-on">1</span><span class="mini-cell"></span><span class="mini-cell mini-cell-on">🚩</span><span class="mini-cell"></span>
      <span class="mini-cell"></span><span class="mini-cell mini-cell-on">2</span><span class="mini-cell"></span><span class="mini-cell"></span>
    </div>`,
  },
  {
    key: 'battleship', title: 'Battleship', tagline: 'Sink the enemy fleet', category: 'classic', accent: 'blue', script: 'battleship.js',
    preview: `<div class="mini-grid mini-grid-5">
      <span class="mini-cell"></span><span class="mini-cell mini-cell-on"></span><span class="mini-cell mini-cell-on"></span><span class="mini-cell mini-cell-on"></span><span class="mini-cell"></span>
      <span class="mini-cell mini-cell-on">✕</span><span class="mini-cell"></span><span class="mini-cell"></span><span class="mini-cell mini-cell-on">•</span><span class="mini-cell"></span>
    </div>`,
  },
  {
    key: 'pong', title: 'Pong', tagline: 'First to 5 wins', category: 'arcade', accent: 'dark', script: 'pong.js',
    preview: `<div class="mini-pong">
      <span class="mini-pong-paddle mini-pong-paddle-l"></span>
      <span class="mini-dot mini-pong-ball"></span>
      <span class="mini-pong-paddle mini-pong-paddle-r"></span>
    </div>`,
  },
  {
    key: 'typing-race', title: 'Typing Race', tagline: 'Type fast and accurately', category: 'skill', accent: 'green', script: 'typing-race.js',
    preview: `<div class="mini-stack">
      <span class="mini-label">Type fast!</span>
      <span class="mini-bar mini-bar-on"></span>
    </div>`,
  },
  {
    key: 'sudoku', title: 'Sudoku', tagline: 'Fill the grid, no repeats', category: 'puzzle', accent: 'purple', script: 'sudoku.js',
    preview: `<div class="mini-grid mini-grid-4">
      <span class="mini-cell mini-cell-on">5</span><span class="mini-cell"></span><span class="mini-cell mini-cell-on">2</span><span class="mini-cell"></span>
      <span class="mini-cell"></span><span class="mini-cell mini-cell-on">9</span><span class="mini-cell"></span><span class="mini-cell mini-cell-on">4</span>
    </div>`,
  },
  {
    key: 'avoid-obstacles', title: 'Avoid the Obstacles', tagline: 'Dodge and survive', category: 'arcade', accent: 'dark', script: 'avoid-obstacles.js',
    preview: `<div class="mini-drive">
      <span class="mini-lane"></span><span class="mini-lane"></span>
      <span class="mini-car mini-car-enemy" style="top:12%;left:12%;"></span>
      <span class="mini-car" style="top:58%;left:55%;"></span>
    </div>`,
  },
  {
    key: 'solitaire', title: 'Solitaire', tagline: 'Classic Klondike solitaire', category: 'classic', accent: 'green', script: 'solitaire.js',
    preview: `<div class="mini-solitaire">
      <span class="mini-card-mini" style="left:0;">9♠</span>
      <span class="mini-card-mini" style="left:22%;">Q♣</span>
      <span class="mini-card-mini mini-card-mini-red" style="left:44%;">7♥</span>
    </div>`,
  },
  {
    key: 'checkers', title: 'Checkers', tagline: 'Capture all opponent pieces', category: 'classic', accent: 'brown', script: 'checkers.js',
    preview: `<div class="mini-grid mini-grid-4 mini-checker-board">
      <span class="mini-checker-sq"></span><span class="mini-checker-sq mini-checker-sq-dark"><span class="mini-piece mini-piece-dark"></span></span><span class="mini-checker-sq"></span><span class="mini-checker-sq mini-checker-sq-dark"></span>
      <span class="mini-checker-sq mini-checker-sq-dark"></span><span class="mini-checker-sq"></span><span class="mini-checker-sq mini-checker-sq-dark"><span class="mini-piece mini-piece-light"></span></span><span class="mini-checker-sq"></span>
    </div>`,
  },
  {
    key: 'chess', title: 'Chess', tagline: 'A classic game of strategy', category: 'classic', accent: 'forest', script: 'chess.js',
    preview: `<div class="mini-grid mini-grid-4 mini-checker-board mini-chess-board">
      <span class="mini-chess-sq mini-chess-light"></span><span class="mini-chess-sq mini-chess-dark">♟</span><span class="mini-chess-sq mini-chess-light"></span><span class="mini-chess-sq mini-chess-dark"></span>
      <span class="mini-chess-sq mini-chess-dark"></span><span class="mini-chess-sq mini-chess-light">♙</span><span class="mini-chess-sq mini-chess-dark"></span><span class="mini-chess-sq mini-chess-light"></span>
    </div>`,
  },
  {
    key: 'riddle-rush', title: 'Riddle Rush', tagline: 'Solve riddles against the clock', category: 'puzzle', accent: 'purple', script: 'riddle-rush.js',
    preview: `<div class="mini-stack">
      <span class="mini-label">What has keys but no locks?</span>
      <span class="mini-bar mini-bar-on"></span>
      <span class="mini-bar"></span>
    </div>`,
  },
  {
    key: 'word-scramble', title: 'Word Scramble', tagline: 'Unscramble the letters', category: 'word', accent: 'yellow', script: 'word-scramble.js',
    preview: `<div class="mini-stack">
      <span class="mini-word">R E V I R</span>
      <span class="mini-label">river</span>
    </div>`,
  },
];

const CATEGORY_LABELS = {
  puzzle: 'Puzzle',
  arcade: 'Arcade',
  word: 'Word',
  classic: 'Classic',
  trivia: 'Trivia',
  skill: 'Skill',
};

function gameByKey(key) {
  return GAMES.find((g) => g.key === key) || null;
}

module.exports = { GAMES, CATEGORY_LABELS, gameByKey };
