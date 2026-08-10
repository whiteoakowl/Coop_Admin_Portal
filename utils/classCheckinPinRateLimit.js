// Brute-force guard for the Class Check-In kiosk flow's shared 4-digit
// PIN (see utils/classCheckinPin.js) - its own independent instance of
// utils/loginRateLimit.js's failure-counting limiter, not a shared one
// with the admin login guard. A 4-digit PIN has only 10,000 possible
// values (vs. an arbitrary-length admin password), so brute-force
// resistance matters even more here, but sharing a counter with admin
// login would let unrelated admin-login typos from the same kiosk IP
// lock out class check-in PIN attempts, and vice versa - confusing
// cross-feature interaction neither guard's own purpose calls for.
const { createFailureRateLimiter } = require('./loginRateLimit');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const limiter = createFailureRateLimiter({ windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS });

module.exports = { ...limiter, WINDOW_MS, MAX_ATTEMPTS };
