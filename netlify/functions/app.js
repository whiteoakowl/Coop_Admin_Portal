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
// IMPORTANT - this function alone is not a complete deployment. See
// MIGRATION.md's "Netlify deployment config" section: until the database
// backend is actually cut over to db/postgres.js (DATABASE_URL pointing at
// the real Supabase project) and the upload routes are switched from
// multer.diskStorage() to utils/storage.js (Supabase Storage), this
// function would boot against a SQLite file that doesn't persist between
// invocations here - every write would vanish on the next cold start. Both
// of those swaps have to land together, in the same deploy, for this to
// actually work in production; this file is the deployment-plumbing half
// of that, ready to go once the other half lands.
const serverless = require('serverless-http');
const app = require('../../server');

module.exports.handler = serverless(app, { binary: true });
