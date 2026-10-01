// A real request: "add chat room where people can talk to each other in
// a live continuous feed." Progressive enhancement over the normal
// threaded Reply form (views/forums-thread.ejs) - without this script
// the page still works exactly like any other forum thread (reload per
// post); with it, messages from other people stream in via polling and
// your own message appears immediately with no reload. Same
// window.CSRF_TOKEN/X-CSRF-Token convention as events-detail-register.js.
(function () {
  var root = document.querySelector('[data-chat-room-feed]');
  if (!root) return;

  var threadId = root.getAttribute('data-thread-id');
  var list = root.querySelector('[data-chat-room-messages]');
  var form = root.querySelector('[data-chat-room-form]');
  var seenIds = {};

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  Array.prototype.forEach.call(list.querySelectorAll('[data-post-id]'), function (el) {
    seenIds[el.getAttribute('data-post-id')] = true;
  });

  function isNearBottom() {
    return window.innerHeight + window.scrollY >= document.body.offsetHeight - 200;
  }

  function renderMessage(p) {
    var div = document.createElement('div');
    div.className = 'forum-post' + (p.status === 'removed' ? ' forum-post-removed' : '');
    div.setAttribute('data-post-id', p.id);
    var authorTitle = p.authorAdminTitle ? '<span class="badge-pill" title="Admin Position">' + escapeHtml(p.authorAdminTitle) + '</span>' : '';
    var body = p.status === 'active' ? '<div class="forum-post-body">' + p.body_html + '</div>' : '<p class="hint">This post was removed by a moderator.</p>';
    div.innerHTML =
      '<div class="forum-post-header"><span class="forum-post-author">' +
      escapeHtml(p.authorName || 'Unknown') +
      '</span>' +
      authorTitle +
      '<span class="hint">' +
      escapeHtml(p.created_at) +
      '</span></div>' +
      body;
    return div;
  }

  function poll() {
    fetch('/forums/threads/' + threadId + '/feed.json', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var wasNearBottom = isNearBottom();
        (data.posts || []).forEach(function (p) {
          if (seenIds[p.id]) return;
          seenIds[p.id] = true;
          list.appendChild(renderMessage(p));
        });
        if (wasNearBottom) window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(function () {});
  }

  var pollTimer = setInterval(poll, 4000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearInterval(pollTimer);
    } else {
      poll();
      pollTimer = setInterval(poll, 4000);
    }
  });

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var editable = form.querySelector('[data-forum-editable]');
      var hidden = form.querySelector('[data-forum-body-input]');
      var body = editable ? editable.innerHTML : hidden ? hidden.value : '';
      var plainText = editable ? editable.textContent : '';
      if (!plainText || !plainText.trim()) return;

      fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'X-CSRF-Token': window.CSRF_TOKEN || '',
        },
        body: 'body=' + encodeURIComponent(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.post) {
            seenIds[data.post.id] = true;
            list.appendChild(renderMessage(data.post));
            window.scrollTo(0, document.body.scrollHeight);
            if (editable) editable.innerHTML = '';
            if (hidden) hidden.value = '';
          } else if (data && data.error) {
            window.alert(data.error);
          }
        })
        .catch(function () {
          form.submit();
        });
    });
  }
})();
