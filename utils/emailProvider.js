// Email provider ABSTRACTION, same shape as utils/smsProvider.js and
// the same reasoning utils/newsletter.js's own header comment already
// gives for not sending a real newsletter email: no email vendor is
// configured anywhere in this app, so send() never makes a real network
// call.
function isConfigured() {
  return false;
}

async function send(emailAddress, _subject, _message) {
  if (!emailAddress) return { status: 'skipped', detail: 'No email address on file.' };
  if (!isConfigured()) return { status: 'skipped', detail: 'No email provider configured.' };
  // Unreachable until a real provider is wired in - kept so the shape
  // of a real send() is visible at the call site.
  return { status: 'sent', detail: null };
}

module.exports = { isConfigured, send };
