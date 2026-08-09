// Real unit coverage for readRowsFromFile's prototype-pollution guard
// (see utils/spreadsheet.js's own comment for the full threat model) -
// this is exactly the kind of protection that looks fine by inspection
// but is easy to silently break in a future edit without a test catching it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readRowsFromFile } = require('../utils/spreadsheet');

test('spreadsheet readRowsFromFile', async (t) => {
  await t.test('parses a normal CSV unchanged', () => {
    const buffer = Buffer.from('Name,Email\nJane Doe,jane@example.com\n');
    const rows = readRowsFromFile(buffer);
    assert.deepEqual(rows, [{ Name: 'Jane Doe', Email: 'jane@example.com' }]);
  });

  await t.test('never lets a parsed row pollute Object.prototype', () => {
    const before = ({}).polluted;
    const buffer = Buffer.from('Name,__proto__\nJane Doe,polluted\n');
    readRowsFromFile(buffer);
    assert.equal(({}).polluted, before, 'Object.prototype must be untouched after parsing a hostile file');
  });

  await t.test('strips dangerous keys from every row, not just the first', () => {
    const buffer = Buffer.from('Name,__proto__\nA,x\nB,y\nC,z\n');
    const rows = readRowsFromFile(buffer);
    for (const row of rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, '__proto__'), false);
    }
  });

  await t.test('an empty file returns an empty array, not a throw', () => {
    assert.deepEqual(readRowsFromFile(Buffer.from('')), []);
  });
});
