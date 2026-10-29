// SMS provider - Telnyx integration. Same send(phone, message) contract
// utils/notifications.js's own notify() already calls through (see that
// file's own header comment) - this file used to be a pure stub ("no
// SMS vendor configured anywhere in this app"); a real request to wire
// up Telnyx plugs in here, behind the identical signature, so nothing
// above this file needed to change at all.
//
// Configured purely through env vars, same "return false/null when
// unconfigured rather than throw" convention utils/storage.js's own
// createStorageClient() already established for Supabase - a dev/test
// environment with no Telnyx credentials set still boots and runs every
// other test unaffected, same as before this file had a real provider
// behind it.
const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages';

// A real request: "Set 160 character length for all texting features
// across the app" - the classic single-segment GSM-7 SMS length, kept
// here (one shared constant, not a magic number repeated at each
// compose box) since this is the one file every texting feature's own
// compose route already goes through on its way to an actual SMS send.
// Enforced where an admin TYPES a message (routes/admin-members.js,
// routes/main-admin-members.js, routes/admin-setup.js, routes/admin-
// volunteers.js, routes/admin-announcements.js, routes/main-admin-
// announcements.js) - never inside send() itself, which also carries
// server-built messages (a filled notification template, a multi-
// recipient Setup/Cleanup or Floater text) that aren't free text an
// admin typed into a box.
const MAX_SMS_LENGTH = 160;

function isConfigured() {
  return !!process.env.TELNYX_API_KEY && !!(process.env.TELNYX_MESSAGING_PROFILE_ID || process.env.TELNYX_FROM_NUMBER);
}

// Telnyx's API requires E.164 (+15551234567); members.phone is a plain
// free-typed field elsewhere in this app (e.g. "(555) 123-4567"), never
// validated into any particular shape at entry. US/Canada-only, same
// assumption utils/dates.js's own Eastern-time helpers already make
// elsewhere in this app - strips everything but digits and accepts a
// bare 10-digit number or an 11-digit one already carrying its leading
// country code 1. Returns null (never guesses) for anything else,
// including a number that already starts with "+" for a country this
// helper doesn't understand.
function toE164(phone) {
  const raw = (phone || '').trim();
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// mediaUrl (optional) - a real request: "add an optional image" to the
// Floater Assignments text-notification popup. Telnyx upgrades a message
// to MMS automatically once media_urls is present; it must be a URL
// Telnyx's own servers can fetch themselves (never a cookie-gated proxy
// path), which is why the Floater notify route only ever uploads this to
// a PUBLIC bucket (routes/admin-volunteers.js) rather than the private
// pattern Family School attachments use.
async function send(phone, message, mediaUrl = null) {
  if (!phone) return { status: 'skipped', detail: 'No phone number on file.' };
  if (!isConfigured()) return { status: 'skipped', detail: 'No SMS provider configured.' };
  const to = toE164(phone);
  if (!to) return { status: 'skipped', detail: `"${phone}" isn't a usable phone number.` };

  try {
    const res = await fetch(TELNYX_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // A Messaging Profile (number pooling/routing, set up once in
        // the Telnyx dashboard) is preferred when set - a single `from`
        // number is the simpler fallback for a co-op with just one
        // registered Telnyx number.
        ...(process.env.TELNYX_MESSAGING_PROFILE_ID
          ? { messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID }
          : { from: process.env.TELNYX_FROM_NUMBER }),
        to,
        text: message,
        ...(mediaUrl ? { media_urls: [mediaUrl] } : {}),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `Telnyx error (HTTP ${res.status})`;
      return { status: 'failed', detail };
    }
    return { status: 'sent', detail: null, messageId: data?.data?.id || null };
  } catch (err) {
    return { status: 'failed', detail: err.message };
  }
}

// Looks up a message's final delivery status by its Telnyx-assigned id -
// the initial send() response only confirms Telnyx *accepted* the
// request, not that a carrier actually delivered it. Used by the Main
// Admin SMS Test page's "Check Delivery Status" lookup, bypassing
// Telnyx's own Reporting UI entirely.
async function getStatus(messageId) {
  if (!process.env.TELNYX_API_KEY) return { error: 'No SMS provider configured.' };
  try {
    const res = await fetch(`${TELNYX_API_URL}/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { error: data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `Telnyx error (HTTP ${res.status})` };
    }
    const msg = data?.data;
    return {
      to: msg?.to?.[0]?.phone_number || null,
      status: msg?.to?.[0]?.status || null,
      from: msg?.from?.phone_number || null,
      sentAt: msg?.sent_at || null,
      completedAt: msg?.completed_at || null,
      errors: msg?.errors || [],
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { isConfigured, send, toE164, getStatus, MAX_SMS_LENGTH };
