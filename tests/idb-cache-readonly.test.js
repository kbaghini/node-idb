import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import sqlite3 from 'sqlite3'

import { createIdb } from 'node-idb'

/** @param {string} target */
async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Captures observable content and metadata which a genuine read-only engine
 * must leave unchanged. Access times are deliberately omitted because merely
 * reading a file may update them on some filesystems.
 * @param {string} storagePath
 */
async function snapshotDirectory(storagePath) {
  const names = (await readdir(storagePath)).sort()
  const directoryInfo = await stat(storagePath, { bigint: true })
  const entries = {}

  for (const name of names) {
    const filename = path.join(storagePath, name)
    const info = await stat(filename, { bigint: true })
    entries[name] = {
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      sha256: info.isFile()
        ? createHash('sha256').update(await readFile(filename)).digest('hex')
        : null,
    }
  }

  return {
    names,
    directoryMtimeNs: String(directoryInfo.mtimeNs),
    entries,
  }
}

/** @param {string} filename */
function openSqlite(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) => {
      if (error) reject(error)
      else resolve(database)
    })
  })
}

/** @param {sqlite3.Database} database @param {string} sql */
function execSqlite(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => error ? reject(error) : resolve())
  })
}

/** @param {sqlite3.Database} database @param {string} sql */
function getSqlite(database, sql) {
  return new Promise((resolve, reject) => {
    database.get(sql, (error, row) => error ? reject(error) : resolve(row))
  })
}

/** @param {sqlite3.Database} database */
function closeSqlite(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve())
  })
}

/**
 * @param {string} storagePath
 * @param {string} [collection]
 * @param {unknown} [document]
 */
async function seedCollection(
  storagePath,
  collection = 'documents',
  document = { key: 'seed', value: 1 },
) {
  const database = createIdb({ storagePath })
  try {
    await database.execute(`INSERT INTO ${collection}`, document)
  } finally {
    await database.close()
  }
  return {
    mainPath: path.join(storagePath, `db-collection-${collection}.sqlite`),
    blobPath: path.join(storagePath, `db-blobs-${collection}.sqlite`),
  }
}

test('maxOpenCollections validates its range and rejects explicit memory caps', async () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '2', null]) {
    assert.throws(
      () => createIdb({ storagePath: './unused-cache-validation', maxOpenCollections: value }),
      /maxOpenCollections.*positive safe integer/i,
    )
  }

  for (const value of [1, 16, 1_000]) {
    assert.throws(
      () => createIdb({ storagePath: ':memory:', maxOpenCollections: value }),
      /maxOpenCollections.*:memory:.*erase/i,
    )
  }

  const memoryWithOmittedCap = createIdb({
    storagePath: ':memory:',
    maxOpenCollections: undefined,
  })
  await memoryWithOmittedCap.close()

  const readonlyWithOmittedPolicies = createIdb({
    storagePath: './unused-readonly-validation',
    mode: 'readonly',
    durability: undefined,
    fieldIndexes: undefined,
  })
  await readonlyWithOmittedPolicies.close()

  assert.throws(
    () => createIdb({ storagePath: ':memory:', mode: 'readonly' }),
    /readonly.*:memory:|:memory:.*readonly/i,
  )

  const boundary = createIdb({
    storagePath: './unused-cache-validation',
    maxOpenCollections: Number.MAX_SAFE_INTEGER,
  })
  await boundary.close()
})

test('caps of one and two preserve every collection through repeated LRU churn', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-lru-persistence-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  for (const maxOpenCollections of [1, 2]) {
    const storagePath = path.join(root, `cap-${maxOpenCollections}`)
    const database = createIdb({ storagePath, maxOpenCollections })
    const expected = new Map([
      ['alpha', []],
      ['beta', []],
      ['gamma', []],
      ['delta', []],
    ])
    const churn = [
      'alpha', 'beta', 'alpha', 'gamma', 'beta', 'delta',
      'alpha', 'gamma', 'delta', 'beta', 'alpha', 'delta',
    ]

    try {
      for (const [sequence, collection] of churn.entries()) {
        const document = { sequence, collection, cap: maxOpenCollections }
        expected.get(collection).push(document)
        await database.execute(`INSERT INTO ${collection}`, document)
      }

      for (const collection of ['gamma', 'alpha', 'delta', 'beta']) {
        assert.deepEqual(
          await database.execute(`FIND ${collection} ORDER BY sequence`),
          expected.get(collection),
        )
      }
    } finally {
      await database.close()
    }

    const reopened = createIdb({ storagePath, maxOpenCollections })
    try {
      for (const collection of ['beta', 'delta', 'alpha', 'gamma']) {
        assert.deepEqual(
          await reopened.execute(`FIND ${collection} ORDER BY sequence`),
          expected.get(collection),
        )
      }
    } finally {
      await reopened.close()
    }
  }
})

test('LRU reopen rejects a deleted main or blob file without recreating it', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-lru-orphan-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  for (const missingKind of ['collection', 'blobs']) {
    const storagePath = path.join(root, missingKind)
    const database = createIdb({ storagePath, maxOpenCollections: 1 })
    const missingPath = path.join(storagePath, `db-${missingKind}-alpha.sqlite`)
    try {
      await database.execute('INSERT INTO alpha', { key: 'stable', value: 1 })
      // Opening beta evicts alpha and closes both of its SQLite handles.
      await database.execute('INSERT INTO beta', { key: 'evictor' })
      await rm(missingPath)

      await assert.rejects(
        database.execute('FIND alpha'),
        /orphaned file.*matching (?:collection|blob) database is missing/i,
      )
      assert.equal(await exists(missingPath), false, 'the missing database must not be recreated')

      // A failed existing-pair reopen must not poison legitimate first use.
      await database.execute('INSERT INTO gamma', { key: 'new-collection' })
      assert.deepEqual(await database.execute('FIND gamma'), [{ key: 'new-collection' }])
    } finally {
      await database.close()
    }
  }
})

test('the cache never evicts a collection while its operation is active', {
  timeout: 20_000,
}, async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-active-cache-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  await seedCollection(storagePath, 'active_alpha', { key: 'alpha' })
  await seedCollection(storagePath, 'active_beta', { key: 'beta' })

  const database = createIdb({ storagePath, maxOpenCollections: 1 })
  try {
    const slowRead = database.execute(`
      QUERY ON active_alpha
      SELECT (
        WITH RECURSIVE counter(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < 2000000
        )
        SELECT sum(value) FROM counter
      ) AS total
    `)
    let waitingReadSettled = false
    const waitingRead = database.execute('FIND active_beta').finally(() => {
      waitingReadSettled = true
    })

    await delay(20)
    assert.equal(waitingReadSettled, false, 'the second collection should wait for capacity')

    assert.deepEqual(await slowRead, [{ total: 2_000_001_000_000 }])
    assert.deepEqual(await waitingRead, [{ key: 'beta' }])
    assert.deepEqual(await database.execute('FIND active_alpha'), [{ key: 'alpha' }])
  } finally {
    await database.close()
  }
})

test('terminal close drains an operation waiting for cache capacity', {
  timeout: 20_000,
}, async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-close-cache-waiter-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  await seedCollection(storagePath, 'close_alpha', { key: 'alpha' })
  await seedCollection(storagePath, 'close_beta', { key: 'beta' })

  const database = createIdb({ storagePath, maxOpenCollections: 1 })
  const active = database.execute(`
    QUERY ON close_alpha
    SELECT (
      WITH RECURSIVE counter(value) AS (
        SELECT 0
        UNION ALL
        SELECT value + 1 FROM counter WHERE value < 2000000
      )
      SELECT sum(value) FROM counter
    ) AS total
  `)
  const capacityWaiter = database.execute('FIND close_beta')
  const closing = database.close()

  let watchdogTimer
  const watchdog = new Promise((resolve, reject) => {
    watchdogTimer = setTimeout(() => {
      reject(new Error('close() did not drain the capacity waiter'))
    }, 10_000)
  })
  try {
    await Promise.race([closing, watchdog])
  } finally {
    clearTimeout(watchdogTimer)
  }
  assert.deepEqual(await active, [{ total: 2_000_001_000_000 }])
  assert.deepEqual(await capacityWaiter, [{ key: 'beta' }])
  await assert.rejects(database.execute('FIND close_alpha'), /closed/i)
})

test(':memory: retains more than the filesystem default of sixteen collections', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  try {
    for (let index = 0; index < 24; index++) {
      await database.execute(`INSERT INTO memory_${index}`, {
        index,
        payload: `collection-${index}`,
      })
    }

    for (let index = 23; index >= 0; index--) {
      assert.deepEqual(await database.execute(`FIND memory_${index}`), [{
        index,
        payload: `collection-${index}`,
      }])
    }
  } finally {
    await database.close()
  }
})

test('readonly mode reads documents without changing bytes, mtimes, or directory entries', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-bytes-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const binary = Buffer.from([0, 1, 2, 127, 128, 254, 255])

  const writable = createIdb({ storagePath })
  await writable.execute('INSERT INTO readonly_docs', {
    key: 'alpha',
    value: 42,
    nested: { enabled: true },
    binary,
  })
  await writable.close()

  const before = await snapshotDirectory(storagePath)
  const database = createIdb({ storagePath, mode: 'readonly', maxOpenCollections: 1 })
  try {
    assert.deepEqual(await database.execute("FIND readonly_docs WHERE key='alpha'"), [{
      key: 'alpha',
      value: 42,
      nested: { enabled: true },
      binary,
    }])
    assert.deepEqual(
      await database.execute('SELECT key AS document_key, value FROM readonly_docs'),
      [{ object_id: 1, document_key: 'alpha', value: 42 }],
    )
    assert.deepEqual(
      await database.execute('QUERY ON readonly_docs SELECT count(*) AS count FROM tbl_record'),
      [{ count: 1 }],
    )
    await assert.rejects(
      database.execute('FIND absent_collection'),
      /does not exist.*read-only|read-only.*does not exist/i,
    )
  } finally {
    await database.close()
  }

  assert.deepEqual(await snapshotDirectory(storagePath), before)
})

test('readonly mode rejects every public mutation command and preserves data', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-mutations-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  await seedCollection(storagePath, 'immutable_docs', { key: 'stable', value: 1 })

  const before = await snapshotDirectory(storagePath)
  const database = createIdb({ storagePath, mode: 'readonly' })
  const mutations = [
    ['INSERT INTO immutable_docs', { key: 'inserted', value: 2 }],
    ["UPDATE immutable_docs SET value=2 WHERE key='stable'", undefined],
    ['UPSERT INTO immutable_docs WHERE key=$key', { key: 'stable', value: 3 }],
    ['REPLACE INTO immutable_docs WHERE key=$key', { key: 'stable', value: 4 }],
    ['UNSET value FROM immutable_docs WHERE key=\'stable\'', undefined],
    ["DELETE FROM immutable_docs WHERE key='stable'", undefined],
  ]

  try {
    for (const [statement, parameters] of mutations) {
      await assert.rejects(
        database.execute(statement, parameters),
        /read-only.*mutation|engine is read-only/i,
      )
    }
    assert.deepEqual(await database.execute('FIND immutable_docs'), [
      { key: 'stable', value: 1 },
    ])
  } finally {
    await database.close()
  }

  assert.deepEqual(await snapshotDirectory(storagePath), before)
})

test('readonly misses never create a storage path or collection files', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-missing-'))
  const storagePath = path.join(root, 'does-not-exist')
  context.after(() => rm(root, { recursive: true, force: true }))

  const database = createIdb({ storagePath, mode: 'readonly' })
  assert.equal(await exists(storagePath), false)
  await assert.rejects(
    database.execute('FIND missing_docs'),
    /does not exist.*read-only|read-only.*does not exist/i,
  )
  await database.close()
  assert.equal(await exists(storagePath), false)
})

test('readonly mode rejects collections requiring old or future schema handling', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-versions-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  for (const [version, expected] of [
    [4, /version 4.*writable migration.*version 5/i],
    [999, /version 999.*newer than supported.*version 5/i],
  ]) {
    const storagePath = path.join(root, `version-${version}`)
    const { mainPath } = await seedCollection(storagePath)
    const sqlite = await openSqlite(mainPath)
    await execSqlite(sqlite, `PRAGMA user_version=${version}`)
    await closeSqlite(sqlite)
    const before = await snapshotDirectory(storagePath)

    const database = createIdb({ storagePath, mode: 'readonly' })
    await assert.rejects(database.execute('FIND documents'), expected)
    await database.close()
    assert.deepEqual(await snapshotDirectory(storagePath), before)
  }
})

test('readonly mode rejects WAL storage instead of converting it', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-wal-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const { mainPath, blobPath } = await seedCollection(storagePath)

  for (const filename of [mainPath, blobPath]) {
    const sqlite = await openSqlite(filename)
    const journal = await getSqlite(sqlite, 'PRAGMA journal_mode=WAL')
    assert.equal(journal.journal_mode, 'wal')
    await closeSqlite(sqlite)
  }

  const database = createIdb({ storagePath, mode: 'readonly' })
  await assert.rejects(
    database.execute('FIND documents'),
    /WAL.*readwrite mode.*DELETE journal mode|requires DELETE journal mode.*wal/i,
  )
  await database.close()

  for (const filename of [mainPath, blobPath]) {
    const sqlite = await openSqlite(filename)
    const journal = await getSqlite(sqlite, 'PRAGMA journal_mode')
    assert.equal(journal.journal_mode, 'wal')
    await closeSqlite(sqlite)
  }
})

test('readonly mode rejects an orphaned collection pair without creating its mate', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-orphan-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const mainPath = path.join(storagePath, 'db-collection-orphan.sqlite')
  const blobPath = path.join(storagePath, 'db-blobs-orphan.sqlite')
  await writeFile(mainPath, 'orphan sentinel')
  const before = await snapshotDirectory(storagePath)

  const database = createIdb({ storagePath, mode: 'readonly' })
  await assert.rejects(database.execute('FIND orphan'), /orphaned.*blob.*missing/i)
  await database.close()

  assert.equal(await exists(blobPath), false)
  assert.deepEqual(await snapshotDirectory(storagePath), before)
})
