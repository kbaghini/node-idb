import test from 'node:test'
import assert from 'node:assert/strict'
import { createParseCache } from '../src/idb/parse-cache.js'
import { parseSql } from '../src/idb/sql.js'
import { createIdb } from '../src/index.js'

test('syntax cache isolates callers and keeps exact SQL keys', async () => {
  let calls = 0
  const parse = createParseCache(async sql => { calls++; return {nested: {sql}} })
  const first = await parse('SELECT ?')
  first.nested.sql = 'changed'
  const second = await parse('SELECT ?')
  assert.equal(second.nested.sql, 'SELECT ?')
  second.nested.sql = 'again'
  assert.equal((await parse('SELECT ?')).nested.sql, 'SELECT ?')
  await parse('select ?')
  assert.equal(calls, 2)
})

test('syntax cache evicts least recently used entries and enforces size limits', async () => {
  let calls = 0
  const raw = async sql => { calls++; return {sql} }
  const parse = createParseCache(raw, {maxEntries: 2})
  for (const sql of ['a', 'b', 'a', 'c', 'a', 'b']) await parse(sql)
  assert.equal(calls, 4)
  for (const limits of [{maxBytes: 1}, {maxSqlLength: 1}, {maxEntries: 0}]) {
    calls = 0
    const limited = createParseCache(raw, limits)
    await limited('long'); await limited('long')
    assert.equal(calls, 2)
  }
  calls = 0
  const bytes = createParseCache(raw, {maxBytes: 30})
  await bytes('a'); await bytes('b'); await bytes('a')
  assert.equal(calls, 3)
})

test('syntax cache retries failures and isolates concurrent completions', async () => {
  let calls = 0
  const parse = createParseCache(async sql => {
    if (++calls === 1) throw new Error('parse failed')
    return {sql}
  })
  await assert.rejects(parse('x'), /parse failed/)
  const results = await Promise.all([parse('x'), parse('x')])
  results[0].sql = 'changed'
  assert.equal(results[1].sql, 'x')
  assert.equal((await parse('x')).sql, 'x')
})

test('real SQL cache preserves placeholders, literals, and mutable AST isolation', async () => {
  for (const sql of [
    'SELECT name, price FROM products WHERE sku = ?',
    'SELECT name FROM products WHERE sku = $sku',
    "SELECT name FROM products WHERE sku = 'CaseSensitive'",
    'SELECT details.? FROM products',
  ]) {
    const ast = await parseSql(sql)
    const expected = structuredClone(ast)
    ast.result = []
    assert.deepEqual(await parseSql(sql), expected)
  }
  await assert.rejects(parseSql('SELECT FROM'))
  await assert.rejects(parseSql('SELECT FROM'))
})

test('cached SQL rebinds parameters and schema and reads current data across engines', async () => {
  const first = createIdb({storagePath: ':memory:', fieldIndexes: 'all'})
  const second = createIdb({storagePath: ':memory:', fieldIndexes: 'none'})
  try {
    await first.execute('INSERT INTO products', [
      {sku: 'a', price: 10}, {sku: 'b', price: 20},
    ])
    // Different field creation order produces a different physical schema.
    await second.execute('INSERT INTO products', {extra: true, price: 99, sku: 'a'})
    const sql = 'SELECT price FROM products WHERE sku = ?'
    const prices = async (db, key) => (await db.execute(sql, [key])).map(row => row.price)
    assert.deepEqual(await prices(first, 'a'), [10])
    assert.deepEqual(await prices(first, 'b'), [20])
    assert.deepEqual(await prices(second, 'a'), [99])
    await first.execute('UPDATE products SET price = ? WHERE sku = ?', [30, 'a'])
    assert.deepEqual(await prices(first, 'a'), [30])
    await first.execute('DELETE FROM products WHERE sku = ?', ['a'])
    assert.deepEqual(await first.execute(sql, ['a']), [])
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})
