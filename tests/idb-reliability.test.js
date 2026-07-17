import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb } from '../src/index.js'
import { CollectionStore } from '../src/idb/collection.js'
import { closeDatabase, openDatabase, run as sqliteRun } from '../src/idb/database.js'
import { compileSelect } from '../src/idb/sql.js'

async function fixture(context, prefix = 'ev3-idb-reliability-') {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), prefix))
  const database = createIdb({ storagePath })
  context.after(async () => {
    await database.close().catch(() => {})
    await rm(storagePath, { recursive: true, force: true })
  })
  return { database, storagePath }
}

test('preserves native values assigned directly by SQL parameters and fields', async (context) => {
  const { database } = await fixture(context)
  const timestamp = new Date('2026-07-17T08:09:10.123Z')
  const bigint = 9_007_199_254_740_997n
  const binary = Buffer.from([0, 127, 128, 255])
  const array = [1, undefined, 3n, { enabled: true }]
  const object = { nested: { enabled: true } }

  await database.execute('reliability', 'INSERT INTO typed_updates', { key: 'typed' })
  await database.execute(
    'reliability',
    `UPDATE typed_updates
        SET timestamp = $timestamp,
            bigint = $bigint,
            binary = $binary,
            array = $array,
            object = $object
      WHERE key = $key`,
    { $key: 'typed', $timestamp: timestamp, $bigint: bigint, $binary: binary, $array: array, $object: object },
  )
  await database.execute(
    'reliability',
    `UPDATE typed_updates
        SET "timestampCopy" = timestamp,
            "bigintCopy" = bigint,
            "binaryCopy" = binary,
            "arrayCopy" = array,
            "objectCopy" = object
      WHERE key = 'typed'`,
  )

  const [document] = await database.execute('reliability', "GET typed_updates WHERE key='typed'")
  assert.deepEqual(document, {
    key: 'typed',
    timestamp,
    bigint,
    binary,
    array,
    object,
    timestampCopy: timestamp,
    bigintCopy: bigint,
    binaryCopy: binary,
    arrayCopy: array,
    objectCopy: object,
  })

  await database.execute('reliability', 'INSERT INTO typed_updates', {
    key: 'swap',
    left: 1,
    right: 2,
  })
  await database.execute(
    'reliability',
    "UPDATE typed_updates SET left=right, right=left WHERE key='swap'",
  )
  assert.deepEqual(
    await database.execute('reliability', "GET typed_updates WHERE key='swap'"),
    [{ key: 'swap', left: 2, right: 1 }],
  )
})

test('round-trips reserved structured-array markers and rejects lossy values', async (context) => {
  const { database } = await fixture(context)
  const markers = [
    { __ev3_idb_type__: 'bigint', value: 'not-a-bigint' },
    { __ev3_idb_type__: 'undefined' },
    { __idb_bigint__: '123' },
  ]
  await database.execute('reliability', 'INSERT INTO structured_arrays', { key: 'markers', markers })
  const [document] = await database.execute('reliability', 'GET structured_arrays')
  assert.deepEqual(document.markers, markers)

  await assert.rejects(
    database.execute('reliability', 'INSERT INTO structured_arrays', {
      key: 'invalid',
      values: [Number.NaN],
    }),
    /finite/i,
  )
  assert.deepEqual(await database.execute(
    'reliability',
    "GET structured_arrays WHERE key='invalid'",
  ), [])
})

test('keeps internal SELECT metadata disjoint from user aliases and field names', async (context) => {
  const { database } = await fixture(context)
  await database.execute('reliability', 'INSERT INTO metadata_aliases', {
    key: 'one',
    array: [1, 2],
    __ev3_idb_internal_type_0__: 'user value',
  })
  assert.deepEqual(
    await database.execute(
      'reliability',
      `SELECT array AS __idb_type_0,
              __ev3_idb_internal_type_0__ AS "__ev3_idb_internal_type_1__"
         FROM metadata_aliases`,
    ),
    [{
      object_id: 1,
      __idb_type_0: [1, 2],
      __ev3_idb_internal_type_1__: 'user value',
    }],
  )
})

test('rejects unsafe update paths without modifying object prototypes', async (context) => {
  const { database } = await fixture(context)
  await database.execute('reliability', 'INSERT INTO safe_documents', { key: 'safe' })

  await assert.rejects(
    database.execute(
      'reliability',
      `UPDATE safe_documents SET "__proto__.polluted" = 1 WHERE key = 'safe'`,
    ),
    /unsafe/i,
  )
  assert.equal(({}).polluted, undefined)
  assert.deepEqual(await database.execute('reliability', 'GET safe_documents'), [{ key: 'safe' }])
})

test('serializes cross-engine merge updates and miss-path upserts', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'ev3-idb-concurrent-mutations-'))
  const first = createIdb({ storagePath })
  const second = createIdb({ storagePath })
  context.after(async () => {
    await Promise.all([first.close().catch(() => {}), second.close().catch(() => {})])
    await rm(storagePath, { recursive: true, force: true })
  })

  await first.execute('shared', 'INSERT INTO counters', { key: 'same', baseline: true })
  await Promise.all([
    first.execute('shared', "UPDATE counters WHERE key='same'", { left: 1 }),
    second.execute('shared', "UPDATE counters WHERE key='same'", { right: 2 }),
  ])
  assert.deepEqual(await first.execute('shared', "GET counters WHERE key='same'"), [{
    key: 'same',
    baseline: true,
    left: 1,
    right: 2,
  }])

  await Promise.all([
    first.execute('shared', "UPSERT INTO unique_docs WHERE key='race'", { key: 'race', left: true }),
    second.execute('shared', "UPSERT INTO unique_docs WHERE key='race'", { key: 'race', right: true }),
  ])
  assert.deepEqual(await first.execute('shared', "GET unique_docs WHERE key='race'"), [{
    key: 'race',
    left: true,
    right: true,
  }])
})

test('rejects ambiguous array payloads for matched mutations without data loss', async (context) => {
  const { database } = await fixture(context)
  const original = { key: 'matched', preserved: true }
  await database.execute('reliability', 'INSERT INTO payload_guards', original)

  for (const statement of [
    "UPDATE payload_guards WHERE key='matched'",
    "UPSERT INTO payload_guards WHERE key='matched'",
    "INSERT OR REPLACE INTO payload_guards WHERE key='matched'",
  ]) {
    await assert.rejects(
      database.execute('reliability', statement, [{ key: 'matched', destructive: true }]),
      /payload|array/i,
    )
    assert.deepEqual(
      await database.execute('reliability', "GET payload_guards WHERE key='matched'"),
      [original],
    )
  }

  const inserted = await database.execute(
    'reliability',
    "UPSERT INTO payload_guards WHERE key='missing'",
    [{ key: 'batch-one' }, { key: 'batch-two' }],
  )
  assert.equal(inserted.length, 2)
  assert.ok(inserted.every((row) => row.inserted === true))
})

test('reports missing external payload rows as storage corruption', async (context) => {
  const { database, storagePath } = await fixture(context)
  await database.execute('reliability', 'INSERT INTO blob_integrity', {
    key: 'corrupt-me',
    text: 'long-text-'.repeat(40),
    array: [1, 2, 3],
    binary: Buffer.from('payload'),
  })
  await database.close()

  const blobDatabase = await openDatabase(path.join(
    storagePath,
    'reliability',
    'db-blobs-blob_integrity.sqlite',
  ))
  await sqliteRun(blobDatabase, 'DELETE FROM tbl_blobs WHERE id=(SELECT MIN(id) FROM tbl_blobs)')
  await closeDatabase(blobDatabase)

  await assert.rejects(
    database.execute('reliability', "GET blob_integrity WHERE key='corrupt-me'"),
    /integrity.*blob|missing blob/i,
  )
})

test('reads large, wide result sets without exceeding SQLite bind limits', async (context) => {
  const { database } = await fixture(context)
  const documents = Array.from({ length: 650 }, (_, ordinal) => ({
    ordinal,
    ...Object.fromEntries(Array.from({ length: 55 }, (_, field) => [`field${field}`, ordinal + field])),
  }))
  await database.execute('reliability', 'INSERT INTO wide_documents', documents)

  const result = await database.execute(
    'reliability',
    'GET wide_documents ORDER BY ordinal',
  )
  assert.equal(result.length, documents.length)
  assert.deepEqual(result[0], documents[0])
  assert.deepEqual(result.at(-1), documents.at(-1))
})

test('uses per-field indexes for common value predicates', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'ev3-idb-index-plan-'))
  const database = createIdb({ storagePath })
  /** @type {CollectionStore | undefined} */
  let store
  context.after(async () => {
    await database.close().catch(() => {})
    await store?.close().catch(() => {})
    await rm(storagePath, { recursive: true, force: true })
  })

  await database.execute(
    'query_plan',
    'INSERT INTO indexed_documents',
    Array.from({ length: 200 }, (_, index) => ({
      key: index === 137 ? 'needle' : `key-${index}`,
      value: index,
    })),
  )
  await database.close()

  store = new CollectionStore({
    project: 'query_plan',
    collection: 'indexed_documents',
    storagePath,
    memory: false,
  })
  await store.initialize()
  const keyField = store.fields.find((field) => field.path === 'key')
  assert.ok(keyField)
  const compiled = await compileSelect(
    store,
    'SELECT key FROM indexed_documents WHERE key = ?',
    ['needle'],
  )
  const plan = await store.rawAll(`EXPLAIN QUERY PLAN ${compiled.sql}`, compiled.parameters)
  assert.ok(
    plan.some((row) => String(row.detail).includes(`idx_values_${keyField.id}_query_object`)),
    `Expected the key value index in query plan: ${JSON.stringify(plan)}`,
  )

  const manyValues = Array.from({ length: 1_200 }, (_, index) => `key-${index}`)
  const placeholders = manyValues.map(() => '?').join(', ')
  const compiledList = await compileSelect(
    store,
    `SELECT key FROM indexed_documents WHERE key IN (${placeholders})`,
    manyValues,
  )
  assert.equal(compiledList.parameters.length, manyValues.length)
  const listRows = await store.rawAll(compiledList.sql, compiledList.parameters)
  assert.equal(listRows.length, 199)
})
