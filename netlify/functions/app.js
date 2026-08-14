// Netlify Function entry point: wraps the exact same Express `app`
// server.js already exports for the test suite (see that file's own
// `require.main === module` guard around `app.listen` - requiring it here
// never opens a real port, same as every test/routes-*.test.js file
// already does) in serverless-http, so every existing route/URL keeps
// working unchanged on Netlify. netlify.toml's catch-all redirect sends
// every request to this one function; Express's own router does the same
// path matching it always did (app.use('/kiosk', ...), app.use('/admin',
// ...), etc.) - Netlify doesn't need to know this app has more than one
// route.
//
// binary: true tells serverless-http to base64-encode any response whose
// Content-Type isn't text-ish - needed for member photo/document downloads
// and the printable-badge PDFs this app serves via res.sendFile/res.send,
// so binary bytes survive the Lambda-style JSON response envelope Netlify
// Functions use under the hood.
//
// server.js's own `require.main === module` block never runs here (this
// file requires server.js, it doesn't execute it as the entry script), so
// the guarantee that block normally gives - the app never accepts a
// request until app.ready (schema + first-boot seeding + the 4 always-
// exist day rosters) has actually resolved - doesn't exist for this
// deployment target on its own. Without awaiting it here, a cold start's
// very first request(s) could reach a route while, say, the admin account
// or a day roster hasn't been seeded yet, throwing on data the route
// assumes already exists - confirmed against a real deploy, where this
// broke both the admin login page and the public floater-assignment
// chart. Every invocation awaits app.ready before delegating to
// serverless-http; after the first one it's already resolved, so this
// adds no real latency beyond that first cold start.
const serverless = require('serverless-http');
const app = require('../../server');

const httpHandler = serverless(app, { binary: true });

module.exports.handler = async (event, context) => {
  // Only waiting, not un-catching: if app.ready is still pending, waiting
  // for it closes the boot race this exists for (see above). But if it's
  // already *rejected* (a real, permanent failure - a bad DATABASE_URL,
  // an unreachable database), re-throwing here would make this handler's
  // own returned promise reject, which Netlify treats as the whole
  // function crashing ("This function has crashed", no HTTP response at
  // all, and free-tier accounts can't see the function logs that would
  // explain why). Falling through to the real request instead means
  // Express's own routing still runs - most routes will fail at their
  // first db query and get the app's normal, visible 500 error page
  // instead of an opaque platform-level crash, and routes that don't
  // touch the db (like /db-diagnostic) work regardless.
  try {
    await app.ready;
  } catch (err) {
    console.error('app.ready rejected - continuing to route the request anyway:', err.message);
  }
  return httpHandler(event, context);
};
