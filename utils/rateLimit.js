// A small, dependency-free per-IP sliding-window limiter, generalized from
// the login-specific utils/loginRateLimit.js (kept separate and untouched -
// its "count failures only, reset on success" shape is specific to a
// brute-force guard and doesn't fit the public forms this is for). Those
// forms have no secret to guess, so this isn't a brute-force defense -
// it's just a floor against a script hammering a public URL with repeated
// real-looking submissions and flooding the review queue behind it.
function createRateLimiter({ windowMs, maxAttempts }) {
  const attempts = new Map(); // ip -> { count, windowStart }

  function isLimited(ip) {
    const entry = attempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > windowMs) {
      attempts.delete(ip);
      return false;
    }
    return entry.count >= maxAttempts;
  }

  function recordAttempt(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      attempts.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts) {
      if (now - entry.windowStart > windowMs) attempts.delete(ip);
    }
  }, windowMs);
  cleanupTimer.unref();

  return { isLimited, recordAttempt };
}

module.exports = { createRateLimiter };
