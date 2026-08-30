// Student Portal > Games > Solitaire (Klondike) - click a card to select
// it, then click a destination pile to move it there (no drag-and-drop,
// to keep this workable on touch screens too).
(function () {
  var tableauEl = document.getElementById('sol-tableau');
  if (!tableauEl) return;
  var stockEl = document.getElementById('sol-stock');
  var wasteEl = document.getElementById('sol-waste');
  var foundationEl = document.getElementById('sol-foundation');
  var resetBtn = document.getElementById('sol-reset');
  var card = document.getElementById('sol-card');

  var SUITS = ['♠', '♥', '♦', '♣'];
  var RED = { '♥': true, '♦': true };
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  var stock, waste, tableau, foundations, selected, banner;

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function newDeck() {
    var deck = [];
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r, i) { deck.push({ suit: s, rank: r, val: i + 1, red: !!RED[s], up: false }); });
    });
    return shuffle(deck);
  }

  function newGame() {
    var deck = newDeck();
    tableau = [];
    for (var i = 0; i < 7; i++) {
      var pile = deck.splice(0, i + 1);
      pile[pile.length - 1].up = true;
      tableau.push(pile);
    }
    stock = deck;
    waste = [];
    foundations = { '♠': [], '♥': [], '♦': [], '♣': [] };
    selected = null;
    if (banner) { banner.remove(); banner = null; }
    render();
  }

  function cardLabel(c) { return c.rank + c.suit; }

  function makeCardEl(c, faceUp, extraClass) {
    var el = document.createElement('div');
    el.className = 'sol-card' + (faceUp ? (c.red ? ' sol-card-red' : ' sol-card-black') : ' sol-card-back') + (extraClass ? ' ' + extraClass : '');
    if (faceUp) el.textContent = cardLabel(c);
    return el;
  }

  function render() {
    stockEl.innerHTML = '';
    stockEl.appendChild(makeCardEl(null, false, stock.length ? '' : 'sol-pile-empty'));
    stockEl.classList.toggle('sol-empty', stock.length === 0);

    wasteEl.innerHTML = '';
    if (waste.length) {
      var top = waste[waste.length - 1];
      var wEl = makeCardEl(top, true, selected && selected.type === 'waste' ? 'sol-card-selected' : '');
      wasteEl.appendChild(wEl);
    }

    foundationEl.innerHTML = '';
    SUITS.forEach(function (s) {
      var pile = foundations[s];
      var slot = document.createElement('div');
      slot.className = 'sol-pile';
      if (pile.length) {
        slot.appendChild(makeCardEl(pile[pile.length - 1], true));
      } else {
        var empty = document.createElement('div');
        empty.className = 'sol-card sol-pile-empty';
        empty.textContent = s;
        slot.appendChild(empty);
      }
      slot.addEventListener('click', function () { tryMoveTo({ type: 'foundation', suit: s }); });
      foundationEl.appendChild(slot);
    });

    tableauEl.innerHTML = '';
    tableau.forEach(function (pile, ci) {
      var col = document.createElement('div');
      col.className = 'sol-col';
      if (!pile.length) {
        var empty = document.createElement('div');
        empty.className = 'sol-card sol-pile-empty';
        col.appendChild(empty);
      }
      pile.forEach(function (c, ri) {
        var isTop = ri === pile.length - 1;
        var isSelected = selected && selected.type === 'tableau' && selected.col === ci && selected.row === ri;
        var el = makeCardEl(c, c.up, isSelected ? 'sol-card-selected' : '');
        el.style.top = (ri * 14) + 'px';
        if (c.up && isTop) {
          el.addEventListener('click', function (e) { e.stopPropagation(); selectTableau(ci, ri); });
        }
        col.appendChild(el);
      });
      col.addEventListener('click', function () { tryMoveTo({ type: 'tableau', col: ci }); });
      tableauEl.appendChild(col);
    });
  }

  function selectTableau(ci, ri) {
    if (selected && selected.type === 'tableau' && selected.col === ci && selected.row === ri) {
      selected = null; render(); return;
    }
    selected = { type: 'tableau', col: ci, row: ri, card: tableau[ci][ri] };
    render();
  }

  stockEl.addEventListener('click', function () {
    if (!stock.length) {
      stock = waste.reverse(); stock.forEach(function (c) { c.up = false; });
      waste = [];
    } else {
      var c = stock.pop();
      c.up = true;
      waste.push(c);
    }
    render();
  });

  wasteEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!waste.length) return;
    if (selected && selected.type === 'waste') { selected = null; render(); return; }
    selected = { type: 'waste', card: waste[waste.length - 1] };
    render();
  });

  function canStackTableau(target, moving) {
    if (!target) return moving.rank === 'K';
    return target.red !== moving.red && target.val === moving.val + 1;
  }

  function canStackFoundation(suit, moving) {
    if (moving.suit !== suit) return false;
    var pile = foundations[suit];
    var topVal = pile.length ? pile[pile.length - 1].val : 0;
    return moving.val === topVal + 1;
  }

  function tryMoveTo(dest) {
    if (!selected) return;
    var moving = selected.card;

    if (dest.type === 'foundation') {
      if (!canStackFoundation(dest.suit, moving)) return;
      removeSelected();
      foundations[dest.suit].push(moving);
    } else if (dest.type === 'tableau') {
      var pile = tableau[dest.col];
      var target = pile.length ? pile[pile.length - 1] : null;
      if (selected.type === 'tableau' && selected.col === dest.col) { selected = null; render(); return; }
      if (!canStackTableau(target, moving)) return;
      removeSelected();
      tableau[dest.col].push(moving);
    } else {
      return;
    }
    selected = null;
    checkWin();
    render();
  }

  function removeSelected() {
    if (selected.type === 'waste') {
      waste.pop();
    } else if (selected.type === 'tableau') {
      var pile = tableau[selected.col];
      pile.pop();
      if (pile.length) pile[pile.length - 1].up = true;
    }
  }

  function checkWin() {
    var total = SUITS.reduce(function (n, s) { return n + foundations[s].length; }, 0);
    if (total === 52) {
      banner = document.createElement('div');
      banner.className = 'game-win-banner';
      banner.textContent = 'You won! 🎉';
      card.insertBefore(banner, resetBtn);
    }
  }

  resetBtn.addEventListener('click', newGame);
  newGame();
})();
