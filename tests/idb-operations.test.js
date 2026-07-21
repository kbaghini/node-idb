import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb, inspectStorage, restoreBackup, verifyBackup } from 'node-idb'

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
