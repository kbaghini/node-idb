import test from 'node:test'
import assert from 'node:assert/strict'
import {openDatabase, all, exec, closeDatabase} from '../src/idb/database.js'

test('prepared reads rebind values, preserve omitted/named bindings and concurrent isolation', async () => {
  const db = await openDatabase(':memory:')
  let prepares = 0
  const prepare = db.prepare
  db.prepare = function (...args) { prepares++; return prepare.apply(this, args) }
  try {
    const sql = 'SELECT ? AS value'
    assert.deepEqual(await all(db, sql, ['first']), [{value: 'first'}])
    assert.deepEqual(await all(db, sql, ['second']), [{value: 'second'}])
    assert.equal(prepares, 1)
    assert.deepEqual(await all(db, sql, []), [{value: null}])
    assert.deepEqual(await all(db, 'SELECT ? AS a, ? AS b', [1, 2]), [{a: 1, b: 2}])
    assert.deepEqual(await all(db, 'SELECT ? AS a, ? AS b', [3]), [{a: 3, b: null}])
    assert.deepEqual(await all(db, 'SELECT $v AS value', {$v: 'named'}), [{value: 'named'}])
    const values = await Promise.all(Array.from({length: 30}, (_, i) => all(db, sql, [i])))
    assert.deepEqual(values.map(rows => rows[0].value), Array.from({length: 30}, (_, i) => i))
    assert.deepEqual(await all(db, sql, ['x'.repeat(1000)]), [{value: 'x'.repeat(1000)}])
  } finally { await closeDatabase(db) }
})

test('prepared read cache handles schema changes and failures without retaining locks', async () => {
  const db = await openDatabase(':memory:')
  try {
    await exec(db, 'CREATE TABLE items (id INTEGER, value TEXT); INSERT INTO items VALUES (1, \'old\')')
    const sql = 'SELECT value FROM items WHERE id = ?'
    assert.deepEqual(await all(db, sql, [1]), [{value: 'old'}])
    await exec(db, 'DROP TABLE items; CREATE TABLE items (value TEXT, id INTEGER); INSERT INTO items VALUES (\'new\', 1)')
    assert.deepEqual(await all(db, sql, [1]), [{value: 'new'}])
    await exec(db, 'DROP TABLE items')
    await assert.rejects(all(db, sql, [1]), /no such table/)
    await exec(db, 'CREATE TABLE items (id INTEGER, value TEXT)')
    assert.deepEqual(await all(db, sql, [1]), [])
    await assert.rejects(all(db, 'SELECT missing FROM nowhere WHERE id = ?', [1]))
  } finally { await closeDatabase(db) }
})

test('prepared read cache is bounded and close drains active cached operations', async () => {
  const db = await openDatabase(':memory:')
  let live = 0
  let peak = 0
  const prepare = db.prepare
  db.prepare = function (...args) {
    const statement = prepare.apply(this, args)
    peak = Math.max(peak, ++live)
    const finalize = statement.finalize
    statement.finalize = function (callback) {
      return finalize.call(this, error => { live--; callback(error) })
    }
    return statement
  }
  try {
    for (let i = 0; i < 70; i++) assert.deepEqual(await all(db, `SELECT ? AS value /* ${i} */`, [i]), [{value: i}])
    assert.equal(live, 32)
    assert.ok(peak <= 32)
    const read = all(db, 'SELECT ? AS final', [42])
    await closeDatabase(db)
    assert.deepEqual(await read, [{final: 42}])
    assert.equal(live, 0)
  } catch (error) {
    await closeDatabase(db).catch(() => {})
    throw error
  }
})

test('interrupted prepared reads are discarded and the connection remains usable', async () => {
  const db = await openDatabase(':memory:')
  try {
    const sql = `SELECT sum(x) AS total FROM (
      WITH RECURSIVE numbers(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM numbers WHERE x < 100000000)
      SELECT x FROM numbers) WHERE ? = 1`
    const pending = all(db, sql, [1])
    const timer = setTimeout(() => db.interrupt(), 25)
    try { await assert.rejects(pending, /interrupt/i) }
    finally { clearTimeout(timer) }
    assert.deepEqual(await all(db, 'SELECT ? AS value', [7]), [{value: 7}])
  } finally { await closeDatabase(db) }
})
