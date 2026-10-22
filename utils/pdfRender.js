// Generates a PDF from one of this app's own print-preview pages by
// rendering its exact HTML in a real headless Chromium and calling
// page.pdf() - the same browser engine that already produces this
// page's @media print output, so "Download as PDF" is a literal copy of
// what printing produces, not a hand-drawn approximation. A real
// request: "the download should be a pdf of exactly how it would also
// look when printing."
//
// Two different Chromium binaries depending on where this runs - the
// same process.env.LAMBDA_TASK_ROOT check server.js/utils/spreadsheet.js
// already use to tell a real Netlify Function invocation apart from
// local dev/tests:
// - On Netlify, @sparticuz/chromium supplies a build slimmed down to fit
//   a Lambda-sized function bundle, unpacked at cold start; puppeteer-
//   core drives it (this app never downloads puppeteer's own bundled
//   Chromium, which wouldn't fit that bundle anyway - see package.json,
//   where puppeteer-core, not plain puppeteer, is the dependency).
// - Locally (dev, tests, this session's own sandbox) that binary isn't
//   present/runnable - these environments already have a full Playwright
//   Chromium installed instead (PLAYWRIGHT_BROWSERS_PATH), which
//   puppeteer-core can drive identically via its own executablePath.
const fs = require('fs');
const path = require('path');

function localChromiumPath() {
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(browsersDir)) return null;
  const dir = fs.readdirSync(browsersDir).find((d) => /^chromium-\d+$/.test(d));
  if (!dir) return null;
  const candidate = path.join(browsersDir, dir, 'chrome-linux', 'chrome');
  return fs.existsSync(candidate) ? candidate : null;
}

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  if (process.env.LAMBDA_TASK_ROOT) {
    // A real production bug: "all pdf buttons in family school management
    // say something went wrong" - confirmed by actually requiring this
    // package and calling its API the way this file used to
    // (TypeError: chromium.executablePath is not a function). @sparticuz/
    // chromium ships as an ES module; a plain require() here returns the
    // module's whole namespace object (__esModule: true, default: <the
    // real chromium object>, ...), not the chromium object itself, so
    // chromium.args/.executablePath()/.headless were all reading
    // properties off the wrong object. .default unwraps it - confirmed by
    // actually launching a real browser and rendering a PDF this way,
    // not just by inspecting the exports.
    const chromiumModule = require('@sparticuz/chromium');
    const chromium = chromiumModule.default || chromiumModule;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  const executablePath = localChromiumPath();
  if (!executablePath) throw new Error('No local Chromium found to render PDFs. Set PLAYWRIGHT_BROWSERS_PATH, or install one.');
  return puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
}

// html is this app's own already-rendered print-preview page (built by
// req.app.render() against a view in views/ - never arbitrary/user-
// supplied markup). preferCSSPageSize honors that view's own
// <style>@page{size:...;margin:...}</style> (the same convention every
// other *-print.ejs view already sets) instead of this file hardcoding
// a second, possibly-drifting copy of that page size.
async function renderHtmlToPdf(html) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMediaType('print');
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

// The real, deployed origin to resolve this page's own relative asset
// URLs (/css/styles.css, /img/logo.png) against - req.app.render()'s
// output never goes through a real HTTP request, so Chromium has no
// "current page URL" of its own to resolve them against (see the
// pdfBaseUrl/<base> handling each *-print.ejs view adds for this exact
// reason). process.env.URL is Netlify's own env var for the site's
// primary URL, always set on a real Function invocation; falls back to
// the request's own protocol/host for local dev and tests, where the
// app really is reachable at that address.
function publicOrigin(req) {
  return process.env.URL || `${req.protocol}://${req.get('host')}`;
}

// Renders one of this app's own EJS views to a PDF buffer, the same way
// its matching print-preview page would print. locals is exactly what a
// normal res.render(viewName, locals) call for that view would need;
// pdfBaseUrl is always added on top of it so the view's relative asset
// URLs resolve correctly (see publicOrigin above).
function renderViewToPdf(req, viewName, locals) {
  return new Promise((resolve, reject) => {
    req.app.render(viewName, { ...locals, pdfBaseUrl: publicOrigin(req) }, (err, html) => {
      if (err) return reject(err);
      renderHtmlToPdf(html).then(resolve, reject);
    });
  });
}

module.exports = { renderHtmlToPdf, renderViewToPdf, publicOrigin };
