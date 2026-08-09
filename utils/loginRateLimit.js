// In-memory brute-force guard for POST /admin/login, keyed by IP. No
// external dependency - this app has exactly one admin account
// (ADMIN_USERNAME), so blocking repeated failures by IP is enough to
// slow down a password-guesser without needing per-account tracking or
// a rate-limiting library. Resets to zero for that IP the moment a
// login actually succeeds, and the window itself expires on its own, so
// a legitimate admin who mistypes their password a few times is never
// stuck waiting past a genuine attack.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const attempts = new Map(); // ip -> { count, windowStart }

function isRateLimited(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

// Sweep expired entries periodically so a long-running server doesn't
// slowly accumulate one Map entry per distinct IP that ever failed a
// login, most of which will never be seen again (scanners, typos, etc).
// unref() so this timer alone never keeps the process alive.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now - entry.windowStart > WINDOW_MS) attempts.delete(ip);
  }
}, WINDOW_MS).unref();

module.exports = { isRateLimited, recordFailure, recordSuccess, WINDOW_MS, MAX_ATTEMPTS };
