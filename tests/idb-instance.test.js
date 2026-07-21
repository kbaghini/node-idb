import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import * as publicApi from 'node-idb'
import { createIdb } from 'node-idb'

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

test('the module exports only the documented factories and offline tools', () => {
  assert.deepEqual(Object.keys(publicApi), [
    'createIdb',
    'inspectStorage',
    'restoreBackup',
    'verifyBackup',
  ])
  assert.equal('default' in publicApi, false)
})

test('createIdb validates required and optional configuration eagerly', async () => {
  const invalid = [
    [() => createIdb(), /options object/i],
    [() => createIdb(null), /options object/i],
    [() => createIdb([]), /options object/i],
    [() => createIdb({}), /storagePath.*non-empty string/i],
    [() => createIdb({ storagePath: '' }), /storagePath.*non-empty string/i],
    [() => createIdb({ storagePath: 42 }), /storagePath.*non-empty string/i],
    [() => createIdb({ storagePath: 'invalid\0path' }), /null bytes/i],
    [() => createIdb({ storagePath: './data', busyTimeoutMs: -1 }), /busyTimeoutMs.*integer/i],
    [() => createIdb({ storagePath: './data', busyTimeoutMs: 1.5 }), /busyTimeoutMs.*integer/i],
    [() => createIdb({ storagePath: './data', busyTimeoutMs: 2_147_483_648 }), /busyTimeoutMs.*integer/i],
    [() => createIdb({ storagePath: './data', durability: 'fast' }), /durability.*strict.*balanced/i],
    [() => createIdb({ storagePath: './data', busyTimeOutMs: 100 }), /unknown.*busyTimeOutMs/i],
  ]

  for (const [operation, expected] of invalid) assert.throws(operation, expected)

  const boundary = createIdb({
    storagePath: ':memory:',
    busyTimeoutMs: 2_147_483_647,
    durability: 'balanced',
  })
  await boundary.close()
})

test('storagePath is the database directory and persisted data reopens in place', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-direct-layout-'))
  const storagePath = path.join(root, 'main-project')
  context.after(() => rm(root, { recursive: true, force: true }))

  const first = createIdb({ storagePath })
  assert.equal(await exists(storagePath), false)
  await first.execute('INSERT INTO settings', { key: 'theme', value: 'dark' })

  assert.deepEqual((await readdir(storagePath)).sort(), [
    'db-blobs-settings.sqlite',
    'db-collection-settings.sqlite',
  ])
  assert.equal(await exists(path.join(storagePath, 'main-project')), false)
  await first.close()

  const reopened = createIdb({ storagePath })
  try {
    assert.deepEqual(await reopened.execute("FIND settings WHERE key='theme'"), [
      { key: 'theme', value: 'dark' },
    ])
  } finally {
    await reopened.close()
  }
})

test('separate storage paths isolate application databases', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-isolated-paths-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const development = createIdb({ storagePath: path.join(root, 'development') })
  const production = createIdb({ storagePath: path.join(root, 'production') })

  try {
    await development.execute('INSERT INTO settings', { environment: 'development' })
    await production.execute('INSERT INTO settings', { environment: 'production' })

    assert.deepEqual(await development.execute('FIND settings'), [
      { environment: 'development' },
    ])
    assert.deepEqual(await production.execute('FIND settings'), [
      { environment: 'production' },
    ])
  } finally {
    await Promise.all([development.close(), production.close()])
  }
})

test('case variants share one collection and legacy-cased files reopen', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-collection-case-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const database = createIdb({ storagePath })

  await database.execute('INSERT INTO Users', { key: 'upper' })
  await database.execute('INSERT INTO users', { key: 'lower' })
  assert.deepEqual(await database.execute('FIND USERS ORDER BY key'), [
    { key: 'lower' },
    { key: 'upper' },
  ])
  assert.deepEqual((await readdir(storagePath)).sort(), [
    'db-blobs-users.sqlite',
    'db-collection-users.sqlite',
  ])
  await database.close()

  await Promise.all([
    rename(
      path.join(storagePath, 'db-collection-users.sqlite'),
      path.join(storagePath, 'db-collection-Users.sqlite'),
    ),
    rename(
      path.join(storagePath, 'db-blobs-users.sqlite'),
      path.join(storagePath, 'db-blobs-Users.sqlite'),
    ),
  ])

  const reopened = createIdb({ storagePath })
  try {
    assert.equal((await reopened.execute('FIND uSeRs')).length, 2)
  } finally {
    await reopened.close()
  }
})

test('relative storage paths resolve when createIdb is called', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-relative-path-'))
  const originalWorkingDirectory = process.cwd()
  const relativePath = path.join('.', 'idbs', 'main-projects')
  const expectedPath = path.join(root, 'idbs', 'main-projects')
  const laterWorkingDirectory = path.join(root, 'later-working-directory')
  context.after(() => rm(root, { recursive: true, force: true }))

  let database
  try {
    await mkdir(laterWorkingDirectory)
    process.chdir(root)
    database = createIdb({ storagePath: relativePath })
    process.chdir(laterWorkingDirectory)

    await database.execute('INSERT INTO paths', { resolvedAtCreation: true })
    assert.equal(await exists(path.join(expectedPath, 'db-collection-paths.sqlite')), true)
    assert.equal(await exists(path.join(laterWorkingDirectory, 'idbs', 'main-projects', 'db-collection-paths.sqlite')), false)
  } finally {
    process.chdir(originalWorkingDirectory)
    await database?.close().catch(() => {})
  }
})

test(':memory: creates isolated non-persistent database instances', async () => {
  const first = createIdb({ storagePath: ':memory:' })
  const second = createIdb({ storagePath: ':memory:' })

  try {
    await first.execute('INSERT INTO sessions', { key: 'first' })
    assert.deepEqual(await first.execute('FIND sessions'), [{ key: 'first' }])
    assert.deepEqual(await second.execute('FIND sessions'), [])
  } finally {
    await Promise.all([first.close(), second.close()])
  }

  await assert.rejects(first.execute('FIND sessions'), /closed/i)
})

test('configured timeout and durability are applied to collection connections', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-options-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const database = createIdb({
    storagePath,
    busyTimeoutMs: 37,
    durability: 'balanced',
  })

  try {
    await database.execute('INSERT INTO options', { enabled: true })
    assert.deepEqual(
      await database.execute(
        'QUERY ON options SELECT timeout, (SELECT synchronous FROM pragma_synchronous) AS synchronous FROM pragma_busy_timeout',
      ),
      [{ timeout: 37, synchronous: 1 }],
    )
  } finally {
    await database.close()
  }
})

test('close waits for active writes and permanently rejects later operations', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-close-write-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const database = createIdb({ storagePath })
  const documents = Array.from({ length: 150 }, (_, index) => ({ index }))

  const write = database.execute('INSERT INTO close_documents', documents)
  const closing = database.close()
  const [ids] = await Promise.all([write, closing])
  assert.equal(ids.length, documents.length)
  await assert.rejects(database.execute('FIND close_documents'), /closed/i)

  const reopened = createIdb({ storagePath })
  try {
    assert.equal((await reopened.execute('FIND close_documents')).length, documents.length)
  } finally {
    await reopened.close()
  }
})

test('close still releases resources when an active operation rejects', async () => {
  const database = createIdb({ storagePath: ':memory:' })
  await database.execute('INSERT INTO close_failures', { key: 'safe' })
  const failing = database.execute(
    `UPDATE close_failures
        SET "__proto__.polluted" = true
      WHERE key = 'safe'`,
  )
  const closing = database.close()

  await assert.rejects(failing, /unsafe/i)
  await assert.doesNotReject(closing)
  await assert.rejects(database.execute('FIND anything'), /closed/i)
})
