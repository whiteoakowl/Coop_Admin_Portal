// Real coverage for db/postgres.js - the async Postgres data-access layer
// that will eventually replace db/index.js's synchronous node:sqlite
// DatabaseSync (see MIGRATION.md). Runs against PGlite (test/pgTestDb.js),
// a real embedded Postgres engine, not a mock - every one of these
// assertions is exercising genuine Postgres behavior (placeholder
// translation, RETURNING, transactions), not a stand-in for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./pgTestDb');
const { toPgPlaceholders, isBareInsert } = require('../db/postgres');

test('toPgPlaceholders converts SQLite-style ? placeholders to Postgres $1, $2, ...', () => {
  assert.equal(toPgPlaceholders('SELECT * FROM members WHERE id = ?'), 'SELECT * FROM members WHERE id = $1');
  assert.equal(
    toPgPlaceholders('UPDATE members SET name = ?, active = ? WHERE id = ?'),
    'UPDATE members SET name = $1, active = $2 WHERE id = $3'
  );
  assert.equal(toPgPlaceholders('SELECT 1'), 'SELECT 1', 'a query with no placeholders is untouched');
});

test('isBareInsert only matches an INSERT with no RETURNING clause of its own', () => {
  assert.equal(isBareInsert('INSERT INTO members (name) VALUES (?)'), true);
  assert.equal(isBareInsert('insert into members (name) values (?)'), true, 'case-insensitive');
  assert.equal(isBareInsert('INSERT INTO members (name) VALUES (?) RETURNING id'), false);
  assert.equal(isBareInsert('UPDATE members SET name = ?'), false);
  assert.equal(isBareInsert('SELECT * FROM members'), false);
});

test('db.prepare(sql).get/.all/.run against a real (PGlite) Postgres engine', async (t) => {
  const db = await createTestDb();
  t.after(() => db.end());

  await t.test('the schema + first-boot seed actually ran (same seed logic as a real deployment)', async () => {
    const admin = await db.prepare('SELECT username FROM admins').get();
    assert.ok(admin, 'the default admin account should have been seeded');
    const pin = await db.prepare("SELECT 1 AS x FROM app_settings WHERE key = 'class_checkin_pin_hash'").get();
    assert.ok(pin, 'the default Class Check-In PIN should have been seeded');
  });

  await t.test('.run() on a bare INSERT auto-gets RETURNING id, exposed as lastInsertRowid', async () => {
    const result = await db.prepare("INSERT INTO families (name) VALUES (?)").run('Test Family');
    assert.equal(typeof result.lastInsertRowid, 'number');
    assert.ok(result.lastInsertRowid > 0);

    const row = await db.prepare('SELECT name FROM families WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(row.name, 'Test Family');
  });

  await t.test('.get() returns undefined (not null/throw) when nothing matches', async () => {
    const row = await db.prepare('SELECT * FROM families WHERE id = ?').get(999999);
    assert.equal(row, undefined);
  });

  await t.test('.all() returns every matching row', async () => {
    await db.prepare('INSERT INTO families (name) VALUES (?)').run('Family A');
    await db.prepare('INSERT INTO families (name) VALUES (?)').run('Family B');
    const rows = await db.prepare("SELECT name FROM families WHERE name LIKE 'Family %' ORDER BY name").all();
    assert.deepEqual(rows.map((r) => r.name), ['Family A', 'Family B']);
  });

  await t.test('an INSERT that already has its own RETURNING clause is left alone, not double-appended', async () => {
    const result = await db.prepare("INSERT INTO families (name) VALUES (?) RETURNING id, name").run('Returning Test');
    // .run() still surfaces lastInsertRowid from whatever RETURNING gave back...
    assert.equal(typeof result.lastInsertRowid, 'number');
    // ...and the query didn't get a second, invalid "RETURNING id RETURNING id" appended.
    const row = await db.prepare('SELECT name FROM families WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(row.name, 'Returning Test');
  });
});

test('db.withTransaction', async (t) => {
  const db = await createTestDb();
  t.after(() => db.end());

  await t.test('commits every statement run through the transaction handle on success', async () => {
    await db.withTransaction(async (tx) => {
      await tx.prepare('INSERT INTO families (name) VALUES (?)').run('Committed Family');
    });
    const row = await db.prepare('SELECT 1 AS x FROM families WHERE name = ?').get('Committed Family');
    assert.ok(row, 'the insert should be visible outside the transaction after it commits');
  });

  await t.test('rolls back every statement in the transaction if the callback throws', async () => {
    await assert.rejects(
      db.withTransaction(async (tx) => {
        await tx.prepare('INSERT INTO families (name) VALUES (?)').run('Rolled Back Family');
        throw new Error('boom');
      }),
      /boom/
    );
    const row = await db.prepare('SELECT 1 AS x FROM families WHERE name = ?').get('Rolled Back Family');
    assert.equal(row, undefined, 'nothing from the failed transaction should have been committed');
  });

  await t.test('foreign key ON DELETE SET NULL still fires correctly inside a transaction', async () => {
    const memberId = await db.withTransaction(async (tx) => {
      const fam = await tx.prepare('INSERT INTO families (name) VALUES (?)').run('FK Test Family');
      const member = await tx
        .prepare('INSERT INTO members (name, barcode, family_id) VALUES (?, ?, ?)')
        .run('FK Test Member', 'fk-test-barcode', fam.lastInsertRowid);
      await tx.prepare('DELETE FROM families WHERE id = ?').run(fam.lastInsertRowid);
      return member.lastInsertRowid;
    });
    const member = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
    assert.equal(member.family_id, null);
  });
});

test('a fresh createTestDb() call is fully isolated from another (no shared state between test files/runs)', async (t) => {
  const dbA = await createTestDb();
  const dbB = await createTestDb();
  t.after(async () => {
    await dbA.end();
    await dbB.end();
  });

  await dbA.prepare('INSERT INTO families (name) VALUES (?)').run('Only In A');
  const inB = await dbB.prepare('SELECT 1 AS x FROM families WHERE name = ?').get('Only In A');
  assert.equal(inB, undefined, "dbB shouldn't see dbA's data - they're separate in-process databases");
});
