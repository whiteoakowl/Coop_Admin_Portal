// Regression coverage for a real production bug: "all pdf buttons...
// say something went wrong." A real Netlify Function log eventually
// showed the actual error: "Error [ERR_REQUIRE_ESM]: require() of ES
// Module .../@sparticuz/chromium/build/index.js ... not supported.
// Instead change the require of index.js ... to a dynamic import()."
// @sparticuz/chromium ships as a pure ES module; esbuild's own
// external-module handling for this package (netlify.toml's
// external_node_modules) bakes a require() of its resolved build/
// index.js path directly into the deployed function bundle, bypassing
// the package's own package.json "exports" map that a plain
// require('@sparticuz/chromium') would otherwise route through a
// CJS-safe entry - Node's require() refuses outright to load real ESM,
// no matter what shape the result would otherwise be.
//
// This is the reason an EARLIER fix here (unwrapping require()'s
// return value at .default, based on a passing local node -e test)
// still crashed in production: running require('@sparticuz/chromium')
// directly under plain Node (not through esbuild's bundling) resolves
// the package by name through its own exports map and never hits
// build/index.js directly, so it never reproduces the real failure -
// there is no way to make a plain `node --test` run reproduce an
// esbuild-bundling-specific resolution difference. What IS testable
// locally, and is the actual fix, is that this code now uses a dynamic
// import() instead of require() (exactly what the real error message
// says to do) and that doing so still produces a real, working PDF.
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderHtmlToPdf } = require('../utils/pdfRender.js');

test('@sparticuz/chromium\'s default export has the shape launchBrowser() depends on', async () => {
  const chromiumModule = await import('@sparticuz/chromium');
  assert.equal(typeof chromiumModule.default.executablePath, 'function');
  assert.ok(Array.isArray(chromiumModule.default.args));
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
