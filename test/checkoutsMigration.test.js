// Real coverage for the checkouts.number NOT NULL -> nullable migration
// in db/index.js (needed so the Class Check-In flow's Check Out button
// can record a checkout with no pickup number - see
// routes/kiosk-class-checkin.js). This is the one migration in the app
// that rebuilds an existing table in place (SQLite can't ALTER a column's
// NOT NULL/CHECK constraints directly), so it's worth verifying for real
// against a database seeded with the OLD schema, not just trusting the
// migration code by inspection - a mistake here would either fail to
// migrate real deployments' existing checkouts tables, or worse, silently
// drop their historical checkout rows during the rebuild.
//
// Everything here runs db/index.js in real subprocesses (not just
// `require`d in-process) so each boot gets its own fresh module state and
// DB connection, exactly like a real app restart would - the same thing
// this migration actually has to work correctly under. The DB is first
// booted normally (so real members/rosters exist, same as any real
// deployment), then checkouts is manually reverted to the OLD NOT-NULL
// shape with a row referencing those real records, simulating "a
// deployment that predates this migration" - then booted again, which is
// where the migration itself actually runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const testDbPath = path.join(os.tmpdir(), `checkouts-migration-test-db-${process.pid}.db`);
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkouts-migration-test-'));
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

test('checkouts.number migration', async (t) => {
  await t.test('an existing NOT NULL checkouts table is rebuilt to allow NULL, preserving existing rows', () => {
    // Step 1: boot the app normally against a fresh DB - real members and
    // rosters get seeded via the current schema (checkouts is already
    // nullable at this point; step 2 deliberately reverts it).
    run(writeScript('boot-fresh.js', `require(${JSON.stringify(dbModulePath)});`));

    // Step 2: revert checkouts to the OLD NOT-NULL shape and seed one row
    // that references a real member/roster - simulating a pre-existing
    // deployment that predates this migration.
    const seedOutput = run(
      writeScript(
        'revert-to-old-schema.js',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.env.DB_PATH);
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(\`
          DROP TABLE checkouts;
          CREATE TABLE checkouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id INTEGER NOT NULL,
            roster_id INTEGER NOT NULL,
            session_date TEXT NOT NULL,
            number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 80),
            check_out_time INTEGER NOT NULL,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(member_id, roster_id, session_date)
          );
        \`);
        const memberId = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Migration Test Kid', 'migration-test-kid', 'student')").run().lastInsertRowid;
        // Rosters are created lazily by the app (ensureDayRoster/
        // ensureClassRoster in utils/classSchedule.js), not seeded at db
        // init - a fresh require('../db') alone has none yet, so seed one
        // directly here.
        const rosterId = db.prepare("INSERT INTO rosters (name, category) VALUES ('Migration Test Roster', 'Class Schedule')").run().lastInsertRowid;
        db.prepare('INSERT INTO checkouts (id, member_id, roster_id, session_date, number, check_out_time) VALUES (1, ?, ?, ?, ?, ?)').run(memberId, rosterId, '2024-01-01', 42, 12345);
        process.stdout.write(JSON.stringify({ memberId, rosterId }));
        db.close();
        `
      )
    );
    const { memberId, rosterId } = JSON.parse(seedOutput);

    // Step 3: boot the app again - this is where db/index.js's migration
    // actually detects the old shape and rebuilds the table.
    run(writeScript('boot-again.js', `require(${JSON.stringify(dbModulePath)});`));

    // Step 4: verify.
    const output = run(
      writeScript(
        'verify.js',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.env.DB_PATH);
        const columns = db.prepare('PRAGMA table_info(checkouts)').all();
        const numberColumn = columns.find((c) => c.name === 'number');
        const row = db.prepare('SELECT * FROM checkouts WHERE id = 1').get();
        process.stdout.write(JSON.stringify({ notnull: numberColumn.notnull, row }));
        db.close();
        `
      )
    );
    const { notnull, row } = JSON.parse(output);

    assert.equal(notnull, 0, 'number column should now be nullable');
    assert.equal(row.number, 42, 'the pre-existing numbered row is preserved');
    assert.equal(row.check_out_time, 12345, "the pre-existing row's other data is preserved");
    assert.equal(row.member_id, memberId);
    assert.equal(row.roster_id, rosterId);
  });

  await t.test('a NULL number can now be inserted - the class check-in checkout use case', () => {
    const output = run(
      writeScript(
        'insert-null-number.js',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.env.DB_PATH);
        const rosterId = db.prepare("SELECT id FROM rosters WHERE name = 'Migration Test Roster'").get().id;
        const memberId = db.prepare("SELECT id FROM members WHERE name = 'Migration Test Kid'").get().id;
        db.prepare("INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, '2024-01-02', NULL, 99999)").run(memberId, rosterId);
        const row = db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND session_date = ?').get(memberId, '2024-01-02');
        process.stdout.write(JSON.stringify(row));
        db.close();
        `
      )
    );
    const row = JSON.parse(output);
    assert.equal(row.number, null);
    assert.equal(row.check_out_time, 99999);
  });

  await t.test('an out-of-range number is still rejected by the CHECK constraint', () => {
    assert.throws(() => {
      run(
        writeScript(
          'insert-bad-number.js',
          `
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.env.DB_PATH);
          const rosterId = db.prepare("SELECT id FROM rosters WHERE name = 'Migration Test Roster'").get().id;
          const memberId = db.prepare("SELECT id FROM members WHERE name = 'Migration Test Kid'").get().id;
          db.prepare("INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, '2024-01-03', 999, 11111)").run(memberId, rosterId);
          `
        )
      );
    });
  });
});
