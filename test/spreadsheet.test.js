// Real unit coverage for readRowsFromFile's prototype-pollution guard
// (see utils/spreadsheet.js's own comment for the full threat model) -
// this is exactly the kind of protection that looks fine by inspection
// but is easy to silently break in a future edit without a test catching it.
const test = require('node:test');
const assert = require('node:assert/strict');
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
});
