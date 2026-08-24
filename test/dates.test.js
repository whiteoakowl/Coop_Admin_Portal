// Real unit coverage for utils/dates.js - the date-handling core almost
// every other part of the app leans on (roster session dates, attendance
// history, class schedule hours, displayed ages). It's pure and
// dependency-free, which is exactly why it's worth pinning down: a subtle
// off-by-one or timezone slip here would silently propagate to nearly
// every page in the app rather than failing loudly anywhere in particular.
//
// Fixed to UTC so the timestamp-formatting assertions below don't depend
// on whatever timezone happens to be set on a developer's machine or a CI
// runner - must be set before utils/dates.js (or anything that transitively
// loads it) is required.
process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  todayISO,
  addDays,
  weekdayOf,
  isValidISODate,
  formatDateLabel,
  formatDateLong,
  formatDateNumeric,
  formatTime,
  formatTimeOfDay,
  formatTimestamp,
  formatFriendlyTimestamp,
  ageFromBirthday,
} = require('../utils/dates');

test('isValidISODate', async (t) => {
  await t.test('accepts a real, well-formed date', () => {
    assert.equal(isValidISODate('2024-06-15'), true);
  });

  await t.test('rejects a non-string', () => {
    assert.equal(isValidISODate(undefined), false);
    assert.equal(isValidISODate(null), false);
    assert.equal(isValidISODate(20240615), false);
  });

  await t.test('rejects garbage text', () => {
    assert.equal(isValidISODate('not-a-date'), false);
    assert.equal(isValidISODate(''), false);
  });

  await t.test('rejects a calendar date that does not exist', () => {
    // JS Date silently rolls Feb 30 into March 2 rather than throwing -
    // this is exactly the case isValidISODate's own round-trip check
    // (toISOFromDate(d) === iso) exists to catch.
    assert.equal(isValidISODate('2024-02-30'), false);
    assert.equal(isValidISODate('2023-04-31'), false);
    assert.equal(isValidISODate('2024-13-01'), false);
  });

  await t.test('handles leap years correctly', () => {
    assert.equal(isValidISODate('2024-02-29'), true); // 2024 is a leap year
    assert.equal(isValidISODate('2023-02-29'), false); // 2023 is not
    assert.equal(isValidISODate('2000-02-29'), true); // divisible by 400
    assert.equal(isValidISODate('1900-02-29'), false); // divisible by 100, not 400
  });

  await t.test('rejects a date missing zero-padding', () => {
    assert.equal(isValidISODate('2024-6-15'), false);
    assert.equal(isValidISODate('2024-06-5'), false);
  });
});

test('addDays', async (t) => {
  await t.test('adds within a month', () => {
    assert.equal(addDays('2024-06-15', 1), '2024-06-16');
  });

  await t.test('subtracts', () => {
    assert.equal(addDays('2024-06-15', -1), '2024-06-14');
  });

  await t.test('rolls over a month boundary', () => {
    assert.equal(addDays('2024-06-30', 1), '2024-07-01');
  });

  await t.test('rolls over a year boundary', () => {
    assert.equal(addDays('2024-12-31', 1), '2025-01-01');
    assert.equal(addDays('2025-01-01', -1), '2024-12-31');
  });

  await t.test('rolls correctly across a leap day', () => {
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  });

  await t.test('zero is a no-op', () => {
    assert.equal(addDays('2024-06-15', 0), '2024-06-15');
  });
});

test('weekdayOf', async (t) => {
  await t.test('matches the real day of the week (0=Sunday..6=Saturday)', () => {
    assert.equal(weekdayOf('2024-06-16'), 0); // Sunday
    assert.equal(weekdayOf('2024-06-17'), 1); // Monday
    assert.equal(weekdayOf('2024-06-19'), 3); // Wednesday
    assert.equal(weekdayOf('2024-06-22'), 6); // Saturday
  });
});

test('todayISO', async (t) => {
  await t.test('matches a real YYYY-MM-DD date that passes its own validator', () => {
    const today = todayISO();
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(isValidISODate(today), true);
  });
});

test('formatDateLabel / formatDateLong', async (t) => {
  await t.test('formatDateLabel is "Weekday M/D"', () => {
    assert.equal(formatDateLabel('2024-06-15'), 'Sat 6/15');
    assert.equal(formatDateLabel('2024-01-05'), 'Fri 1/5');
  });

  await t.test('formatDateLong is the full "Weekday, Month D, YYYY" form', () => {
    assert.equal(formatDateLong('2024-06-15'), 'Sat, June 15, 2024');
  });
});

// Real request: a student's imported birthday showed on the Members list
// as its raw stored ISO value ("2026-02-03") - MM/DD/YYYY, zero-padded,
// reads as a birthday instead.
test('formatDateNumeric is zero-padded MM/DD/YYYY', () => {
  assert.equal(formatDateNumeric('2026-02-03'), '02/03/2026');
  assert.equal(formatDateNumeric('2024-11-25'), '11/25/2024');
  assert.equal(formatDateNumeric('2024-01-01'), '01/01/2024');
});

test('formatTime', async (t) => {
  await t.test('returns null for a falsy input rather than "Invalid Date"', () => {
    assert.equal(formatTime(null), null);
    assert.equal(formatTime(0), null);
    assert.equal(formatTime(undefined), null);
  });

  // A real bug report: "check in and out times should read Eastern Time
  // (ET)." formatTime always renders in America/New_York regardless of
  // the server's own OS timezone (Netlify Functions run in UTC) - this
  // epoch is 14:30 UTC in June (EDT, UTC-4), so it should read 10:30 AM,
  // not the server-local "2:30 PM" a bare toLocaleTimeString would give
  // on a UTC host.
  await t.test('formats a real epoch timestamp as h:mm AM/PM, in Eastern Time regardless of server timezone', () => {
    const epoch = new Date('2024-06-15T14:30:00Z').getTime();
    assert.equal(formatTime(epoch), '10:30 AM');
  });

  // Same conversion, but in January (EST, UTC-5, no daylight saving) -
  // proves this uses the real America/New_York IANA zone (which already
  // knows the EST/EDT boundary) rather than a fixed UTC-4/-5 offset.
  await t.test('accounts for standard time (EST, UTC-5) in winter, not just daylight time', () => {
    const epoch = new Date('2024-01-15T14:30:00Z').getTime();
    assert.equal(formatTime(epoch), '9:30 AM');
  });

  // Coverage for a live bug report: attendance.check_in_time/checkouts.
  // check_out_time are Postgres bigint columns, and the pg driver returns
  // a bigint as a STRING (to avoid silent precision loss on values past
  // Number.MAX_SAFE_INTEGER), not a number - invisible locally/in tests,
  // which run on PGlite, whose driver already returns bigint as a plain
  // number, so only a real Postgres deploy ever passed formatTime a
  // string. new Date(numericString) doesn't parse as milliseconds - it's
  // treated as an unparseable date STRING, so the real bug produced
  // "Invalid Date" as literal on-screen text everywhere a check-in/
  // check-out time is shown (the Attendance grid's "In/Out" badge, the
  // Logs > Check In/Out tab, member profile history, CSV exports).
  await t.test('formats correctly even when epochMs arrives as a numeric STRING (Postgres bigint-as-string)', () => {
    const epoch = new Date('2024-06-15T14:30:00Z').getTime();
    assert.equal(formatTime(String(epoch)), '10:30 AM');
  });

  await t.test('returns null (not "Invalid Date") for a falsy/zero value that arrives as a string too', () => {
    assert.equal(formatTime('0'), null);
    assert.equal(formatTime(''), null);
  });
});

test('formatTimeOfDay', async (t) => {
  await t.test('returns null for a falsy or malformed input', () => {
    assert.equal(formatTimeOfDay(null), null);
    assert.equal(formatTimeOfDay(''), null);
    assert.equal(formatTimeOfDay('not-a-time'), null);
  });

  await t.test('formats 24-hour HH:MM as a 12-hour label', () => {
    assert.equal(formatTimeOfDay('14:30'), '2:30 PM');
    assert.equal(formatTimeOfDay('08:05'), '8:05 AM');
  });

  await t.test('handles the midnight/noon boundary correctly (not "0:00")', () => {
    assert.equal(formatTimeOfDay('00:00'), '12:00 AM');
    assert.equal(formatTimeOfDay('12:00'), '12:00 PM');
  });
});

test('formatTimestamp / formatFriendlyTimestamp', async (t) => {
  await t.test('return null for a falsy input', () => {
    assert.equal(formatTimestamp(null), null);
    assert.equal(formatFriendlyTimestamp(null), null);
  });

  await t.test('convert a SQLite UTC datetime string to a local label', () => {
    assert.equal(formatTimestamp('2024-06-15 16:30:00'), '6/15/2024, 4:30 PM');
    assert.equal(formatFriendlyTimestamp('2024-06-15 16:30:00'), 'June 15, 2024 4:30pm');
  });

  await t.test('formatFriendlyTimestamp pads single-digit minutes', () => {
    assert.equal(formatFriendlyTimestamp('2024-06-15 09:05:00'), 'June 15, 2024 9:05am');
  });
});

test('ageFromBirthday', async (t) => {
  await t.test('returns null for an invalid or missing birthday', () => {
    assert.equal(ageFromBirthday(null), null);
    assert.equal(ageFromBirthday(''), null);
    assert.equal(ageFromBirthday('not-a-date'), null);
    assert.equal(ageFromBirthday('2024-02-30'), null);
  });

  await t.test("computes whole years old as of today, both before and after this year's birthday", async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-06-15T12:00:00Z').getTime() });
    try {
      // Birthday already happened this year (Jan 1) - full year counted.
      assert.equal(ageFromBirthday('2015-01-01'), 9);
      // Birthday is today - counts as already happened.
      assert.equal(ageFromBirthday('2015-06-15'), 9);
      // Birthday hasn't happened yet this year (December) - not counted yet.
      assert.equal(ageFromBirthday('2015-12-25'), 8);
      // A future birthday (bad data) returns null rather than a negative age.
      assert.equal(ageFromBirthday('2030-01-01'), null);
      // A newborn (birthday this year) is age 0, not null.
      assert.equal(ageFromBirthday('2024-03-01'), 0);
    } finally {
      t.mock.timers.reset();
    }
  });
});
