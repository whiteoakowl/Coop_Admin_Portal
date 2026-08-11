// Real coverage for the member_code backfill migration in db/index.js -
// see db/schema.sql's own comment on member_code for the full context.
// Every member used to have barcode set to their own name, which meant a
// printed barcode's width varied with how long that person's name was
// (public/js/barcode-print-shrink-name.js's own notes cover why that
// mattered enough to fix). Barcodes now encode a fixed-length 6-digit
// member_code instead, assigned once at creation (utils/members.js's
// generateMemberCode) - this suite covers the other half: every member
// who predates that change (member_code IS NULL) gets one backfilled on
// the next boot, with their barcode updated to match, so old deployments
// don't need a hands-on migration step. The user explicitly chose this
// "backfill everyone at once" tradeoff over "new members only" - it means
// every already-printed barcode/name tag stops scanning until reprinted.
//
// Runs db/index.js in real subprocesses (not just required in-process),
// same pattern as test/checkoutsMigration.test.js - each boot gets its
// own fresh module state and DB connection, exactly like a real app
// restart, which is what this migration actually has to work correctly
// under.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const testDbPath = path.join(os.tmpdir(), `member-code-migration-test-db-${process.pid}.db`);
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-code-migration-test-'));
const dbModulePath = path.join(__dirname, '..', 'db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function writeScript(name, contents) {
  const filePath = path.join(scratchDir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function run(scriptPath) {
  return execFileSync(process.execPath, [scriptPath], { env: { ...process.env, DB_PATH: testDbPath }, stdio: 'pipe' }).toString();
}

test('member_code backfill migration', async (t) => {
  await t.test('members predating this change (member_code IS NULL, barcode = their old name-based value) get backfilled on the next boot', () => {
    // Step 1: boot fresh - schema.sql already defines member_code (it's a
    // new install), so this just gets an empty, fully-current DB.
    run(writeScript('boot-fresh.js', `require(${JSON.stringify(dbModulePath)});`));

    // Step 2: seed two "legacy" members directly - barcode set to their
    // own name (the old convention) and member_code left NULL, simulating
    // a deployment that predates generateMemberCode() entirely.
    run(
      writeScript(
        'seed-legacy-members.js',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.env.DB_PATH);
        db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Legacy Kid One', 'Legacy Kid One', 'student')").run();
        db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Legacy Kid Two', 'Legacy Kid Two', 'student')").run();
        db.close();
        `
      )
    );

    // Step 3: boot again - this is where the backfill actually runs.
    const bootOutput = run(writeScript('boot-again.js', `require(${JSON.stringify(dbModulePath)});`));
    assert.match(bootOutput, /Assigned a new 6-digit member ID.*to 2 existing member/);

    // Step 4: verify.
    const output = run(
      writeScript(
        'verify.js',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.env.DB_PATH);
        const rows = db.prepare("SELECT name, barcode, member_code FROM members WHERE name LIKE 'Legacy Kid%' ORDER BY name").all();
        process.stdout.write(JSON.stringify(rows));
        db.close();
        `
      )
    );
    const rows = JSON.parse(output);

    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.member_code, /^\d{6}$/, `${row.name}'s member_code should be exactly 6 digits`);
      assert.equal(row.barcode, row.member_code, `${row.name}'s barcode should now match their member_code, not their old name-based value`);
      assert.notEqual(row.barcode, row.name, "the old name-based barcode value shouldn't still be there");
    }
    assert.notEqual(rows[0].member_code, rows[1].member_code, 'two different members must not end up with the same code');
  });

  await t.test('booting a third time is a no-op - nobody is missing a code anymore, so nothing gets reassigned', () => {
    const before = JSON.parse(
      run(
        writeScript(
          'read-before.js',
          `
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.env.DB_PATH);
          const rows = db.prepare("SELECT name, member_code FROM members WHERE name LIKE 'Legacy Kid%' ORDER BY name").all();
          process.stdout.write(JSON.stringify(rows));
          db.close();
          `
        )
      )
    );

    const bootOutput = run(writeScript('boot-third-time.js', `require(${JSON.stringify(dbModulePath)});`));
    assert.doesNotMatch(bootOutput, /Assigned a new 6-digit member ID/, 'nothing should need backfilling anymore');

    const after = JSON.parse(
      run(
        writeScript(
          'read-after.js',
          `
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.env.DB_PATH);
          const rows = db.prepare("SELECT name, member_code FROM members WHERE name LIKE 'Legacy Kid%' ORDER BY name").all();
          process.stdout.write(JSON.stringify(rows));
          db.close();
          `
        )
      )
    );

    assert.deepEqual(after, before, "already-backfilled members' codes must not change on a later boot");
  });
});
