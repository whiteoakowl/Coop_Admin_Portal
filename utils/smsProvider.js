// SMS provider ABSTRACTION (Community & Commerce track, item 11) - "a
// provider abstraction, don't hard-wire one vendor," per the handoff.
// No SMS vendor (Twilio or otherwise) is configured anywhere in this
// app, so send() never makes a real network call - it reports back
// what a real integration would need (a destination phone number) and
// why it didn't actually send, the same "build the real workflow, stop
// short of the real integration" reasoning utils/payments.js already
// established for payment processors. A real provider would plug in
// here behind this same send(phone, message) signature - nothing above
// this file (utils/notifications.js) would need to change.
function isConfigured() {
  return false;
}

async function send(phone, _message) {
  if (!phone) return { status: 'skipped', detail: 'No phone number on file.' };
  if (!isConfigured()) return { status: 'skipped', detail: 'No SMS provider configured.' };
  // Unreachable until a real provider is wired in - kept so the shape
  // of a real send() is visible at the call site.
  return { status: 'sent', detail: null };
}

module.exports = { isConfigured, send };
