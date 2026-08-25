// Minimal rich-text editor for forum posts (Community & Commerce track,
// item 6) - "keep it simple, don't overbuild": a small toolbar over a
// contenteditable div using the browser's own execCommand, syncing its
// innerHTML into the hidden textarea the form actually submits. The
// server (utils/sanitizeHtml.js) is what actually enforces which tags
// survive - this is just the authoring UI.
(function () {
  function initEditor(wrapper) {
    var editable = wrapper.querySelector('[data-forum-editable]');
    var hidden = wrapper.querySelector('[data-forum-body-input]');
    if (!editable || !hidden) return;

    wrapper.querySelectorAll('[data-forum-cmd]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var cmd = btn.getAttribute('data-forum-cmd');
        var value = btn.getAttribute('data-forum-value') || null;
        editable.focus();
        if (cmd === 'formatBlock' && value === 'blockquote') {
          document.execCommand('formatBlock', false, 'blockquote');
        } else if (cmd === 'createLink') {
          var url = window.prompt('Link URL:');
          if (url) document.execCommand('createLink', false, url);
        } else {
          document.execCommand(cmd, false, value);
        }
        sync();
      });
    });

    function sync() {
      hidden.value = editable.innerHTML;
    }
    editable.addEventListener('input', sync);
    wrapper.closest('form').addEventListener('submit', sync);
  }

  document.querySelectorAll('[data-forum-editor]').forEach(initEditor);
})();
