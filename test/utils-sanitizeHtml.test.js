// Direct unit coverage for utils/sanitizeHtml.js - the single
// authoritative allowlist every rich-text body passes through
// regardless of which client produced it (see that file's own header
// comment). No server/DB needed since sanitizePostBody is a pure
// function.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePostBody } = require('../utils/sanitizeHtml');

test('a checklist item survives intact, including its <label> wrapper', () => {
  const html = '<ul><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>Bring snacks</p></div></li></ul>';
  const out = sanitizePostBody(html);
  assert.match(out, /<label>/);
  assert.match(out, /<input type="checkbox" checked disabled="disabled"\s*\/?>/);
  assert.match(out, /Bring snacks/);
  // data-type/data-checked on li ARE kept (see the dedicated round-trip
  // test below for why) - the ul itself carries no data-type here since
  // this particular input never set one; a separate test below covers
  // the ul case.
  assert.match(out, /data-type="taskItem"/);
  assert.match(out, /data-checked="true"/);
});

test('a <label> with an onclick handler has the handler stripped, not the tag', () => {
  const out = sanitizePostBody('<label onclick="alert(1)">Click</label>');
  assert.match(out, /<label>Click<\/label>/);
  assert.doesNotMatch(out, /onclick/);
});

test('a non-checkbox <input> inside a <label> is still dropped entirely', () => {
  const out = sanitizePostBody('<label><input type="text" name="evil"></label>');
  assert.doesNotMatch(out, /<input/);
});

// A real bug found by testing the editor's own save-reload round trip:
// TipTap's task-list/task-item nodes only recognize a checklist by its
// data-type/data-checked attributes, not by tag alone - without these
// surviving sanitization, a saved checklist silently degrades into a
// plain bullet list (and loses its checked state) the next time the
// page loads.
test('a checklist keeps the data-type/data-checked attributes its own parser needs to recognize it on the next load', () => {
  const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>Done already</p></div></li></ul>';
  const out = sanitizePostBody(html);
  assert.match(out, /<ul data-type="taskList">/);
  assert.match(out, /<li data-type="taskItem" data-checked="true">/);
});

test('data-type/data-checked on an unrelated tag are still stripped - only ul/li carry them', () => {
  const out = sanitizePostBody('<p data-type="taskItem" data-checked="true">Not a checklist</p>');
  assert.doesNotMatch(out, /data-type/);
  assert.doesNotMatch(out, /data-checked/);
});
