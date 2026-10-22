// Regression coverage for a real production bug: "all pdf buttons in
// family school management say something went wrong." Confirmed to be
// a dependency API-shape mismatch in utils/pdfRender.js's Netlify
// (LAMBDA_TASK_ROOT) code path, not an infra/deploy problem: @sparticuz/
// chromium ships as an ES module, so require('@sparticuz/chromium')
// returns the module's whole namespace object ({ __esModule: true,
// default: <the real chromium object>, ... }), not the chromium object
// itself. The old code read .args/.executablePath()/.headless straight
// off that namespace object, which has none of those, throwing
// "TypeError: chromium.executablePath is not a function" on every
// Download PDF click in production. This test exercises the exact same
// require()'d package and launch path the Netlify Function uses (by
// setting LAMBDA_TASK_ROOT, the same flag server.js/utils/spreadsheet.js
// already use to detect a real Function invocation), so it fails
// against the old unwrapped-require code and passes against the fix.
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderHtmlToPdf } = require('../utils/pdfRender.js');

test('@sparticuz/chromium exports the real chromium object at .default, not at the top level', () => {
  // Pins down the exact shape that broke the old code, independent of
  // actually launching a browser - a namespace object has no .args/
  // .executablePath of its own.
  const chromiumModule = require('@sparticuz/chromium');
  assert.equal(typeof chromiumModule.executablePath, 'undefined', 'the require()\'d module itself has no executablePath - it is an ESM namespace object');
  assert.equal(typeof chromiumModule.default.executablePath, 'function', 'the real chromium object lives at .default');
  assert.ok(Array.isArray(chromiumModule.default.args), 'the real chromium object exposes .args');
});

test('renderHtmlToPdf() produces a real PDF on the Netlify (LAMBDA_TASK_ROOT) code path', async (t) => {
  const previousLambdaTaskRoot = process.env.LAMBDA_TASK_ROOT;
  process.env.LAMBDA_TASK_ROOT = '/var/task';
  t.after(() => {
    if (previousLambdaTaskRoot === undefined) delete process.env.LAMBDA_TASK_ROOT;
    else process.env.LAMBDA_TASK_ROOT = previousLambdaTaskRoot;
  });

  const buf = await renderHtmlToPdf('<html><body><h1>Lambda PDF test</h1></body></html>');
  // page.pdf() resolves a Uint8Array, not a true Node Buffer - wrap it
  // before slicing/toString() the same way every other PDF test in this
  // codebase checks the magic bytes (those go through supertest's own
  // response buffering, which already hands back a real Buffer).
  assert.equal(Buffer.from(buf).slice(0, 5).toString(), '%PDF-');
});
