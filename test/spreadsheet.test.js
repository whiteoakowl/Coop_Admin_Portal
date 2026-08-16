// Real unit coverage for readRowsFromFile's prototype-pollution guard
// (see utils/spreadsheet.js's own comment for the full threat model) -
// this is exactly the kind of protection that looks fine by inspection
// but is easy to silently break in a future edit without a test catching it.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { readRowsFromFile } = require('../utils/spreadsheet');

test('spreadsheet readRowsFromFile', async (t) => {
  await t.test('parses a normal CSV unchanged', async () => {
    const buffer = Buffer.from('Name,Email\nJane Doe,jane@example.com\n');
    const rows = await readRowsFromFile(buffer);
    assert.deepEqual(rows, [{ Name: 'Jane Doe', Email: 'jane@example.com' }]);
  });

  await t.test('never lets a parsed row pollute Object.prototype', async () => {
    const before = ({}).polluted;
    const buffer = Buffer.from('Name,__proto__\nJane Doe,polluted\n');
    await readRowsFromFile(buffer);
    assert.equal(({}).polluted, before, 'Object.prototype must be untouched after parsing a hostile file');
  });

  await t.test('strips dangerous keys from every row, not just the first', async () => {
    const buffer = Buffer.from('Name,__proto__\nA,x\nB,y\nC,z\n');
    const rows = await readRowsFromFile(buffer);
    for (const row of rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, '__proto__'), false);
    }
  });

  await t.test('an empty file returns an empty array, not a throw', async () => {
    assert.deepEqual(await readRowsFromFile(Buffer.from('')), []);
  });

  await t.test('a file that fails to parse rejects the promise instead of throwing synchronously or hanging', async () => {
    // A truncated/malformed zip signature - .xlsx is a zip archive
    // internally, so this reliably fails inside the worker rather than
    // being silently accepted the way plain garbage text is (XLSX.read
    // treats unparseable plain text as a one-cell sheet, not an error).
    const buffer = Buffer.from('PK\x03\x04not a real zip archive');
    await assert.rejects(() => readRowsFromFile(buffer));
  });

  await t.test('a slow parse is actually terminated by the timeout, not just theoretically guarded', async () => {
    // Proves the ReDoS mitigation's actual mechanism (worker.terminate()
    // firing on a real timer) rather than trusting it by inspection -
    // an ordinary, perfectly valid file with an unreasonably tiny
    // timeout reliably loses the race against real worker-thread
    // startup + parse time, exactly the same way a pathologically slow
    // file would against the real 10s default.
    const buffer = Buffer.from('Name,Email\nJane Doe,jane@example.com\n');
    await assert.rejects(() => readRowsFromFile(buffer, 1), /took too long/);
  });

  // A real bug report: typing "10:00 AM" into an actual spreadsheet
  // (Excel/Google Sheets, not a plain-text CSV) doesn't produce the text
  // "10:00 AM" in that cell - it produces a numeric time-of-day serial
  // (a fraction of a day) with a Time number format applied, and reading
  // that cell's raw underlying value (SheetJS's default) hands back the
  // number, not the formatted clock string every caller expects
  // (parseClockMinutes here, the Student/Parent Schedule import's own
  // start-time class-matching, birthday parsing elsewhere). That silently
  // broke the Schedule import's class-matching for exactly the rows whose
  // spreadsheet cell Excel had auto-formatted as Time, dropping those
  // enrollments with no error - just a quietly higher "skipped" count -
  // which then showed up as a too-short Arrival/Departure window on the
  // Attendance roster.
  await t.test('a genuine Excel Time-formatted cell reads back as formatted clock text, not a raw numeric serial', async () => {
    const ws = {};
    ws['A1'] = { t: 's', v: 'Class Start Time' };
    ws['A2'] = { t: 'n', v: 10 / 24, z: 'h:mm AM/PM' }; // what Excel actually stores for "10:00 AM"
    ws['!ref'] = 'A1:A2';
    const wb = { SheetNames: ['Sheet1'], Sheets: { Sheet1: ws } };
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const rows = await readRowsFromFile(buffer);
    assert.equal(rows[0]['Class Start Time'], '10:00 AM');
  });

  await t.test('a genuine Excel Date-formatted cell (e.g. a birthday column) reads back as formatted text too', async () => {
    const ws = {};
    ws['A1'] = { t: 's', v: 'Birthday' };
    // Excel date serial for 2015-03-14 (days since 1899-12-30, its epoch).
    ws['A2'] = { t: 'n', v: 42077, z: 'm/d/yyyy' };
    ws['!ref'] = 'A1:A2';
    const wb = { SheetNames: ['Sheet1'], Sheets: { Sheet1: ws } };
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const rows = await readRowsFromFile(buffer);
    assert.equal(rows[0]['Birthday'], '3/14/2015');
  });
});
