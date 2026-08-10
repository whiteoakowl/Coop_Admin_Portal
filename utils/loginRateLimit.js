// In-memory brute-force guard, keyed by IP, for endpoints protecting a
// single shared secret (POST /admin/login's ADMIN_PASSWORD; the Class
// Check-In kiosk flow's shared 4-digit PIN - see
// utils/classCheckinPinRateLimit.js). No external dependency - since
// each of those has exactly one secret to guess (not one per account),
// blocking repeated failures by IP is enough to slow down a guesser
// without needing per-account tracking or a rate-limiting library.
// Resets to zero for that IP the moment an attempt actually succeeds,
// and the window itself expires on its own, so someone who mistypes a
// few times is never stuck waiting past a genuine attack.
function createFailureRateLimiter({ windowMs, maxAttempts }) {
  const attempts = new Map(); // ip -> { count, windowStart }

  function isRateLimited(ip) {
    const entry = attempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > windowMs) {
      attempts.delete(ip);
      return false;
    }
    return entry.count >= maxAttempts;
  }

  function recordFailure(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      attempts.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
  }

  function recordSuccess(ip) {
    attempts.delete(ip);
  }

  // Sweep expired entries periodically so a long-running server doesn't
  // slowly accumulate one Map entry per distinct IP that ever failed,
  // most of which will never be seen again (scanners, typos, etc).
  // unref() so this timer alone never keeps the process alive.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts) {
      if (now - entry.windowStart > windowMs) attempts.delete(ip);
    }
  }, windowMs).unref();

  return { isRateLimited, recordFailure, recordSuccess };
}

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

// The admin-login guard itself - a singleton (not a fresh instance per
// require()), same as before this file grew the factory above it.
const adminLoginLimiter = createFailureRateLimiter({ windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS });

module.exports = {
  isRateLimited: adminLoginLimiter.isRateLimited,
  recordFailure: adminLoginLimiter.recordFailure,
  recordSuccess: adminLoginLimiter.recordSuccess,
  WINDOW_MS,
  MAX_ATTEMPTS,
  createFailureRateLimiter,
};
