import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb, inspectStorage, restoreBackup, verifyBackup } from 'node-idb'
import sqlite3 from 'sqlite3'
import { CollectionStore } from '../src/idb/collection.js'

test('cancelled public mutations roll back before commit and report success after commit dispatch', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  const originalWrite = CollectionStore.prototype.writeEncodedDocuments
  const originalExec = sqlite3.Database.prototype.exec
  try {
    await database.execute('INSERT INTO examples', { value: 1 })
    const beforeCommit = new AbortController()
    CollectionStore.prototype.writeEncodedDocuments = async function (...args) {
      const result = await originalWrite.apply(this, args)
      beforeCommit.abort()
      return result
    }
    await assert.rejects(database.execute('UPDATE examples', { value: 2 }, {
      signal: beforeCommit.signal,
    }), { name: 'AbortError' })
    CollectionStore.prototype.writeEncodedDocuments = originalWrite
    assert.deepEqual(await database.execute('FIND examples'), [{ value: 1 }])

    const duringCommit = new AbortController()
    sqlite3.Database.prototype.exec = function (sql, callback) {
      if (sql === 'COMMIT') {
        // The boundary has been crossed; abort while SQLite owns the commit.
        duringCommit.abort()
      }
      return originalExec.call(this, sql, callback)
    }
    await database.execute('UPDATE examples', { value: 3 }, { signal: duringCommit.signal })
    sqlite3.Database.prototype.exec = originalExec
    assert.deepEqual(await database.execute('FIND examples'), [{ value: 3 }])

    const failedCommit = new AbortController()
    sqlite3.Database.prototype.exec = function (sql, callback) {
      if (sql === 'COMMIT') {
        failedCommit.abort()
        // Fail without committing: the SQLite error must survive a late abort.
        return originalExec.call(this, 'SELECT missing_commit_probe', callback)
      }
      return originalExec.call(this, sql, callback)
    }
    await assert.rejects(database.execute('UPDATE examples', { value: 4 }, {
      signal: failedCommit.signal,
    }), { code: 'SQLITE_ERROR' })
    sqlite3.Database.prototype.exec = originalExec
    assert.deepEqual(await database.execute('FIND examples'), [{ value: 3 }])
  } finally {
    CollectionStore.prototype.writeEncodedDocuments = originalWrite
    sqlite3.Database.prototype.exec = originalExec
    await database.close()
  }
})

test('payload UPDATE preserves quoted collection identifiers', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  try {
    for (const name of ['order-items', 'select']) {
      await database.execute(`INSERT INTO "${name}"`, [{ value: 1 }, { value: 2 }])
      await database.execute(`UPDATE "${name}" WHERE value = 1`, { value: 3 })
      assert.deepEqual(await database.execute(`FIND "${name}" ORDER BY value`), [
        { value: 2 }, { value: 3 },
      ])
    }
  } finally {
    await database.close()
  }
})

test('stream executes volatile ordering once and finalizes on early return', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  try {
    await database.execute('INSERT INTO examples', Array.from({ length: 100 }, (_, id) => ({ id })))
    const ids = []
    for await (const row of database.stream('SELECT id FROM examples ORDER BY random()', [], { batchSize: 10 })) {
      ids.push(row.id)
    }
    assert.equal(ids.length, 100)
    assert.equal(new Set(ids).size, 100)
    const rows = []
    for await (const row of database.stream('SELECT id FROM examples ORDER BY id LIMIT ? OFFSET ?', [13, 7], { batchSize: 4 })) {
      rows.push(row.id)
    }
    assert.deepEqual(rows, Array.from({ length: 13 }, (_, index) => index + 7))
    for await (const row of database.stream('FIND examples', [], { batchSize: 1 })) {
      assert.ok(row)
      break
    }
    await database.execute('INSERT INTO examples', { id: 100 })
    assert.equal((await database.execute('FIND examples')).length, 101)
    await assert.rejects(async () => {
      for await (const row of database.stream('SELECT nonexistent_function(id) FROM examples')) {
        assert.fail(`Unexpected row: ${row}`)
      }
    })
    assert.equal((await database.execute('FIND examples')).length, 101)
  } finally {
    await database.close()
  }
})

test('large writes remain atomic across encoding batches, including blob rows and new fields', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  const documents = Array.from({ length: 350 }, (_, id) => ({
    id, nested: { value: id }, bytes: Buffer.from([id]), tags: [id, new Date(id)],
  }))
  try {
    await database.execute('INSERT INTO examples', { sentinel: true })
    await assert.rejects(database.execute('INSERT INTO examples', [
      ...documents, { invalid: Number.NaN },
    ]), /finite/)
    assert.deepEqual(await database.execute('FIND examples'), [{ sentinel: true }])
    const ids = await database.execute('INSERT INTO examples', documents)
    assert.equal(new Set(ids).size, documents.length)
    assert.deepEqual(await database.execute('FIND examples WHERE id >= 0 ORDER BY id'), documents)
    await database.execute('UPDATE examples WHERE id >= 0', { updated: true })
    assert.deepEqual(await database.execute('FIND examples WHERE id >= 0 ORDER BY id'),
      documents.map((document) => ({ ...document, updated: true })))
  } finally {
    await database.close()
  }
})

test('aborting a backpressured stream releases its cursor and queued writer', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  const controller = new AbortController()
  const iterator = database.stream('FIND examples', [], { batchSize: 1, signal: controller.signal })[Symbol.asyncIterator]()
  try {
    await database.execute('INSERT INTO examples', Array.from({ length: 100 }, (_, id) => ({ id })))
    assert.equal((await iterator.next()).done, false)
    const writer = database.execute('INSERT INTO examples', { id: 100 })
    // Let the producer fill its bounded queue while the consumer is paused.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await writer
    await assert.rejects(iterator.next(), { name: 'AbortError' })
    assert.equal((await database.execute('FIND examples')).length, 101)
  } finally {
    await iterator.return()
    await database.close()
  }
})

test('execute supports cancellation and deadlines without poisoning the connection', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  try {
    const controller = new AbortController()
    controller.abort('cancelled by test')
    await assert.rejects(
      database.execute('SELECT value FROM examples', [], { signal: controller.signal }),
      { name: 'AbortError', code: 'ABORT_ERR' },
    )

    await database.execute('INSERT INTO examples', { value: 1 })
    await assert.rejects(
      database.execute(
        `QUERY ON examples SELECT sum(x) FROM (
          WITH RECURSIVE sequence(x) AS (
            SELECT 1 UNION ALL SELECT x + 1 FROM sequence WHERE x < 100000000
          ) SELECT x FROM sequence
        )`,
        [],
        { timeoutMs: 5 },
      ),
      { name: 'TimeoutError', code: 'IDB_TIMEOUT' },
    )
    assert.deepEqual(await database.execute('FIND examples'), [{ value: 1 }])
  } finally {
    await database.close()
  }
})

test('stream incrementally reads SELECT rows and FIND documents', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  try {
    const documents = Array.from({ length: 125 }, (_, value) => ({ value }))
    await database.execute('INSERT INTO examples', documents)

    const selected = []
    for await (const row of database.stream(
      'SELECT value FROM examples ORDER BY value',
      [],
      { batchSize: 17 },
    )) selected.push(row.value)
    assert.deepEqual(selected, documents.map((document) => document.value))

    const found = []
    for await (const document of database.stream(
      'FIND examples ORDER BY value DESC',
      [],
      { batchSize: 19 },
    )) {
      found.push(document.value)
      if (found.length === 23) break
    }
    assert.deepEqual(found, documents.slice(-23).reverse().map((document) => document.value))
    assert.equal((await database.execute('FIND examples')).length, 125)

    const typed = [
      {
        order: 1,
        name: 'object',
        details: {
          createdAt: new Date('2026-07-21T10:00:00.000Z'),
          value: 12n,
          bytes: Buffer.from([1, 2, 3]),
          empty: {},
        },
        tags: ['one', { enabled: true }],
      },
      { order: 2, name: 'array', details: [new Date(10), 13n], tags: [] },
      { order: 3, name: 'missing' },
    ]
    await database.execute('INSERT INTO structured_streams', typed)

    const projected = await database.execute(
      'SELECT details, name, tags FROM structured_streams ORDER BY `order`',
    )
    const streamedProjection = []
    for await (const row of database.stream(
      'SELECT details, name, tags FROM structured_streams ORDER BY `order`',
      [],
      { batchSize: 1 },
    )) streamedProjection.push(row)
    assert.deepEqual(streamedProjection, projected)

    const selectedDocuments = []
    for await (const document of database.stream(
      'SELECT item.* FROM structured_streams AS item ORDER BY item.`order`',
      [],
      { batchSize: 1 },
    )) selectedDocuments.push(document)
    const foundDocuments = []
    for await (const document of database.stream(
      'FIND structured_streams ORDER BY `order`',
      [],
      { batchSize: 2 },
    )) foundDocuments.push(document)
    assert.deepEqual(selectedDocuments, typed)
    assert.deepEqual(foundDocuments, typed)
    assert.deepEqual(await database.execute('SELECT * FROM structured_streams ORDER BY `order`'), typed)
    assert.deepEqual(await database.execute('FIND structured_streams ORDER BY `order`'), typed)

    const literal = `semi;${'long-text-'.repeat(40)}`
    const literalDocument = { label: literal, matched: true }
    await database.execute('INSERT INTO literal_streams', literalDocument)
    const literalStatement = `SELECT * FROM literal_streams WHERE label = '${literal}'`
    assert.deepEqual(await database.execute(literalStatement), [literalDocument])
    const streamedLiteral = []
    for await (const document of database.stream(literalStatement, [], { batchSize: 1 })) {
      streamedLiteral.push(document)
    }
    assert.deepEqual(streamedLiteral, [literalDocument])
  } finally {
    await database.close()
  }
})

test('diagnostics, statistics, analyze, and vacuum expose safe operational data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-operations-'))
  const database = createIdb({ storagePath: root, maxOpenCollections: 1 })
  try {
    await database.execute('INSERT INTO alpha', { value: 1 })
    await database.execute('INSERT INTO beta', { value: 2 })
    const diagnostics = await database.diagnostics()
    assert.deepEqual(diagnostics.collections, ['alpha', 'beta'])
    assert.equal(diagnostics.schemaVersion, 5)
    assert.equal(diagnostics.cache.limit, 1)
    assert.equal(diagnostics.cache.open, 1)
    assert.ok(diagnostics.cache.evictions >= 1)
    assert.equal(diagnostics.openCollections[0].schemaVersion, 5)

    const stats = await database.storageStats()
    assert.equal(stats.collections.length, 2)
    assert.ok(stats.fileBytes > 0)
    assert.equal((await database.analyze()).length, 2)
    assert.equal((await database.vacuum({ collections: ['alpha'] }))[0].operation, 'vacuum')
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('verified backups restore to inspectable, immediately usable storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-restore-'))
  const storagePath = path.join(root, 'source')
  const backupPath = path.join(root, 'backup')
  const restoredPath = path.join(root, 'restored')
  const database = createIdb({ storagePath })
  try {
    await database.execute('INSERT INTO records', { id: 1, name: 'restored' })
    await database.backup({ destinationPath: backupPath })
    const verified = await verifyBackup({ backupPath, integrityCheck: 'full' })
    assert.deepEqual(verified.collections, ['records'])
    const restored = await restoreBackup({ backupPath, destinationPath: restoredPath })
    assert.equal(restored.replaced, false)
    const inspection = await inspectStorage({ storagePath: restoredPath })
    assert.equal(inspection.collections[0].schemaVersion, 5)

    const copy = createIdb({ storagePath: restoredPath, mode: 'readonly' })
    try {
      assert.deepEqual(await copy.execute('FIND records'), [{ id: 1, name: 'restored' }])
    } finally {
      await copy.close()
    }
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
