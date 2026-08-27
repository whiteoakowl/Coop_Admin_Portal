// Shared rich-text editor for anywhere the app lets someone write
// formatted text - chat posts, publications, the weekly newsletter,
// announcements/notifications, and class/event descriptions. A real
// request: "chat posts should have all of these options for editing the
// text ... same for class details, event creation details, writing
// emails, notifications, weekly newsletter, anywhere there is text." A
// toolbar over a contenteditable div using the browser's own
// execCommand, syncing its innerHTML into the hidden input the form
// actually submits. The server (utils/sanitizeHtml.js) is what actually
// enforces which tags/styles survive - this is just the authoring UI, so
// every control here maps to something that sanitizer allows through.
(function () {
  function initEditor(wrapper) {
    var editable = wrapper.querySelector('[data-forum-editable]');
    var hidden = wrapper.querySelector('[data-forum-body-input]');
    if (!editable || !hidden) return;

    // execCommand only ever acts on the LAST real selection - clicking a
    // toolbar <select>/<input type=color> steals focus away from the
    // contenteditable div first, which would otherwise collapse it. Keep
    // our own copy so every control can restore it right before acting.
    var savedRange = null;
    function saveSelection() {
      var sel = window.getSelection();
      if (sel.rangeCount && editable.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
    }
    function restoreSelection() {
      if (!savedRange) return;
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    editable.addEventListener('mouseup', saveSelection);
    editable.addEventListener('keyup', saveSelection);

    function sync() {
      hidden.value = editable.innerHTML;
    }

    // Source view - a plain textarea of the same underlying HTML,
    // swapped in over the contenteditable div. Created on first use
    // rather than hand-added to every calling template's markup.
    var source = null;
    var sourceOn = false;
    function toggleSource() {
      if (!source) {
        source = document.createElement('textarea');
        source.className = 'forum-editable forum-editor-source-view';
        source.hidden = true;
        editable.insertAdjacentElement('afterend', source);
      }
      sourceOn = !sourceOn;
      if (sourceOn) {
        source.value = editable.innerHTML;
        editable.hidden = true;
        source.hidden = false;
      } else {
        editable.innerHTML = source.value;
        source.hidden = true;
        editable.hidden = false;
        sync();
      }
    }

    function closestBlock(node) {
      var el = node && node.nodeType === 3 ? node.parentElement : node;
      while (el && el !== editable && !/^(P|DIV|LI|BLOCKQUOTE|H1|H2|H3|H4|TD|TH)$/.test(el.tagName)) {
        el = el.parentElement;
      }
      return el && el !== editable ? el : null;
    }

    // No execCommand for text direction - apply `dir` directly to the
    // nearest block ancestor of the caret instead, same as the other
    // rich-text controls here, so it's real DOM inside `editable` and
    // survives the innerHTML sync (unlike setting `editable.dir` itself,
    // which lives on the wrapper element sync() never reads).
    function toggleDirection() {
      restoreSelection();
      var sel = window.getSelection();
      if (!sel.rangeCount) return;
      var el = closestBlock(sel.getRangeAt(0).startContainer);
      if (!el) return;
      el.setAttribute('dir', el.getAttribute('dir') === 'rtl' ? 'ltr' : 'rtl');
      sync();
    }

    // Plain substring replace, but walking text nodes only - never
    // touches editable.innerHTML as a string, so it can't accidentally
    // corrupt a tag whose markup happens to contain the search text.
    function findReplaceAll(find, replace) {
      if (!find) return;
      var walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.indexOf(find) !== -1) node.nodeValue = node.nodeValue.split(find).join(replace);
      }
      sync();
    }

    function insertTable() {
      var rows = parseInt(window.prompt('Number of rows:', '2'), 10);
      var cols = parseInt(window.prompt('Number of columns:', '2'), 10);
      if (!rows || !cols || rows < 1 || cols < 1) return;
      rows = Math.min(rows, 20);
      cols = Math.min(cols, 10);
      var html = '<table><tbody>';
      for (var r = 0; r < rows; r++) {
        html += '<tr>';
        for (var c = 0; c < cols; c++) html += '<td>&nbsp;</td>';
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      editable.focus();
      restoreSelection();
      document.execCommand('insertHTML', false, html);
      sync();
    }

    function togglePopup(name) {
      wrapper.querySelectorAll('[data-forum-popup]').forEach(function (p) {
        var isTarget = p.getAttribute('data-forum-popup') === name;
        p.hidden = isTarget ? !p.hidden : true;
      });
    }

    wrapper.querySelectorAll('.forum-editor-symbol-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        editable.focus();
        restoreSelection();
        document.execCommand('insertText', false, btn.getAttribute('data-forum-symbol') || btn.textContent);
        sync();
        togglePopup('symbol');
      });
    });

    var doReplaceBtn = wrapper.querySelector('[data-forum-do-replace]');
    if (doReplaceBtn) {
      doReplaceBtn.addEventListener('click', function (e) {
        e.preventDefault();
        var findInput = wrapper.querySelector('[data-forum-find]');
        var replaceInput = wrapper.querySelector('[data-forum-replace]');
        findReplaceAll(findInput ? findInput.value : '', replaceInput ? replaceInput.value : '');
        togglePopup('findreplace');
      });
    }

    function runCommand(cmd, value) {
      switch (cmd) {
        case 'toggleSource':
          toggleSource();
          return;
        case 'toggleSpellcheck':
          editable.spellcheck = !editable.spellcheck;
          return;
        case 'toggleDirection':
          toggleDirection();
          return;
        case 'toggleFullscreen':
          wrapper.classList.toggle('forum-editor-fullscreen');
          return;
        case 'findReplace':
          togglePopup('findreplace');
          return;
        case 'insertSymbol':
          togglePopup('symbol');
          return;
        case 'insertTable':
          insertTable();
          return;
        case 'createLink': {
          var url = window.prompt('Link URL:');
          if (!url) return;
          editable.focus();
          restoreSelection();
          document.execCommand('createLink', false, url);
          break;
        }
        case 'insertImage': {
          var src = window.prompt('Image URL:');
          if (!src) return;
          editable.focus();
          restoreSelection();
          document.execCommand('insertImage', false, src);
          break;
        }
        default:
          editable.focus();
          restoreSelection();
          document.execCommand(cmd, false, value || null);
      }
      sync();
    }

    wrapper.querySelectorAll('[data-forum-cmd]').forEach(function (control) {
      var cmd = control.getAttribute('data-forum-cmd');
      if (control.tagName === 'SELECT') {
        control.addEventListener('change', function () {
          if (!control.value) return;
          runCommand(cmd, control.value);
          control.value = '';
        });
      } else if (control.tagName === 'INPUT' && control.type === 'color') {
        control.addEventListener('input', function () {
          runCommand(cmd, control.value);
        });
      } else if (control.tagName === 'BUTTON') {
        control.addEventListener('click', function (e) {
          e.preventDefault();
          var value = control.getAttribute('data-forum-value') || null;
          runCommand(cmd, value);
          if (control.hasAttribute('data-forum-toggle')) control.classList.toggle('forum-editor-toggle-on');
        });
      }
    });

    editable.addEventListener('input', sync);
    var form = wrapper.closest('form');
    if (form) form.addEventListener('submit', sync);
  }

  document.querySelectorAll('[data-forum-editor]').forEach(initEditor);
})();
