import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  StorageCatalog,
  StorageCatalogError,
  acquireStorageCatalog,
  releaseStorageCatalog,
} from '../src/idb/storage.js'

/** @param {string} target */
async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** @param {string[]} names */
function directoryEntries(names) {
  return names.map((name) => ({ name }))
}

test('one lazy scan supports read-only misses and lowercase reservations', async () => {
  const storagePath = path.join(os.tmpdir(), `node-idb-catalog-missing-${process.pid}-${Date.now()}`)
  let scans = 0
  let creates = 0
  const catalog = new StorageCatalog(storagePath, {
    async readDirectory() {
      scans++
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    async makeDirectory() {
      creates++
    },
  })

  assert.equal(await catalog.resolvePair('Users', { create: false }), null)
  assert.equal(scans, 1)
  assert.equal(creates, 0)

  const reserved = await catalog.resolvePair('Users')
  assert.deepEqual(reserved, {
    collection: 'users',
    databasePath: path.join(path.resolve(storagePath), 'db-collection-users.sqlite'),
    blobPath: path.join(path.resolve(storagePath), 'db-blobs-users.sqlite'),
    existing: false,
  })
  assert.equal(scans, 1)
  assert.equal(creates, 1)

  assert.deepEqual(await catalog.resolvePair('USERS'), reserved)
  assert.equal(scans, 1)
  assert.equal(creates, 1)
  assert.deepEqual(await catalog.listPairs(), [])
  assert.deepEqual(await catalog.listPairs({ includeReserved: true }), [reserved])
  assert.equal(scans, 1)
})

test('a real read-only miss does not create its storage directory', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-catalog-readonly-'))
  const storagePath = path.join(root, 'does-not-exist')
  context.after(() => rm(root, { recursive: true, force: true }))

  const catalog = new StorageCatalog(storagePath)
  assert.equal(await catalog.resolvePair('missing', { create: false }), null)
  assert.equal(await exists(storagePath), false)
})

test('legacy filename casing is preserved and both files are resolved in one scan', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-catalog-legacy-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  await Promise.all([
    writeFile(path.join(storagePath, 'db-collection-Users.sqlite'), ''),
    writeFile(path.join(storagePath, 'db-blobs-USERS.sqlite'), ''),
    writeFile(path.join(storagePath, 'db-collection-Users.sqlite-journal'), ''),
    writeFile(path.join(storagePath, 'notes.txt'), ''),
  ])

  let scans = 0
  const catalog = new StorageCatalog(storagePath, {
    async readDirectory(...arguments_) {
      scans++
      return readdir(...arguments_)
    },
  })

  const pair = await catalog.resolvePair('users', { create: false })
  assert.deepEqual(pair, {
    collection: 'users',
    databasePath: path.join(storagePath, 'db-collection-Users.sqlite'),
    blobPath: path.join(storagePath, 'db-blobs-USERS.sqlite'),
    existing: true,
  })
  assert.deepEqual(await catalog.resolvePair('UsErS'), pair)
  assert.deepEqual(await catalog.listPairs(), [pair])
  assert.equal(scans, 1)
})

test('case-only duplicates are rejected before resolving or listing a pair', async () => {
  const catalog = new StorageCatalog(path.join(os.tmpdir(), 'node-idb-catalog-ambiguous'), {
    async readDirectory() {
      return directoryEntries([
        'db-collection-Users.sqlite',
        'db-collection-users.sqlite',
        'db-blobs-users.sqlite',
      ])
    },
  })

  await assert.rejects(
    catalog.resolvePair('USERS'),
    (error) => {
      assert.ok(error instanceof StorageCatalogError)
      assert.equal(error.code, 'IDB_AMBIGUOUS_COLLECTION_FILES')
      assert.equal(error.collection, 'users')
      assert.deepEqual(error.files, [
        'db-blobs-users.sqlite',
        'db-collection-Users.sqlite',
        'db-collection-users.sqlite',
      ])
      return true
    },
  )
  await assert.rejects(catalog.listPairs(), /differ only by collection-name casing/i)
})

test('orphaned collection and blob files fail safely in writable and read-only modes', async () => {
  for (const filename of [
    'db-collection-events.sqlite',
    'db-blobs-events.sqlite',
  ]) {
    let creates = 0
    const catalog = new StorageCatalog(path.join(os.tmpdir(), `node-idb-catalog-orphan-${filename}`), {
      async readDirectory() {
        return directoryEntries([filename])
      },
      async makeDirectory() {
        creates++
      },
    })

    for (const create of [false, true]) {
      await assert.rejects(
        catalog.resolvePair('events', { create }),
        (error) => {
          assert.ok(error instanceof StorageCatalogError)
          assert.equal(error.code, 'IDB_ORPHANED_COLLECTION_FILES')
          assert.equal(error.collection, 'events')
          return true
        },
      )
    }
    await assert.rejects(catalog.refresh(), /orphaned file/i)
    assert.equal(creates, 0)
  }
})

test('refreshed listings discover new pairs and validate backup input', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-catalog-refresh-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  await Promise.all([
    writeFile(path.join(storagePath, 'db-collection-alpha.sqlite'), ''),
    writeFile(path.join(storagePath, 'db-blobs-alpha.sqlite'), ''),
  ])
  const catalog = new StorageCatalog(storagePath)

  assert.deepEqual(
    (await catalog.listPairs()).map(({ collection }) => collection),
    ['alpha'],
  )

  await Promise.all([
    writeFile(path.join(storagePath, 'db-collection-Beta.sqlite'), ''),
    writeFile(path.join(storagePath, 'db-blobs-Beta.sqlite'), ''),
  ])
  assert.deepEqual(
    (await catalog.listPairs()).map(({ collection }) => collection),
    ['alpha'],
  )
  assert.deepEqual(
    (await catalog.listPairs({ refresh: true })).map(({ collection }) => collection),
    ['alpha', 'beta'],
  )

  await writeFile(path.join(storagePath, 'db-collection-gamma.sqlite'), '')
  await assert.rejects(catalog.refresh(), /orphaned file/i)
})

test('concurrent resolution shares one scan and one canonical reservation', async () => {
  let scans = 0
  let releaseScan
  const scanBarrier = new Promise((resolve) => {
    releaseScan = resolve
  })
  const catalog = new StorageCatalog(path.join(os.tmpdir(), 'node-idb-catalog-concurrent'), {
    async readDirectory() {
      scans++
      await scanBarrier
      return []
    },
    async makeDirectory() {},
  })

  const first = catalog.resolvePair('Jobs')
  const second = catalog.resolvePair('JOBS')
  releaseScan()
  const [firstPair, secondPair] = await Promise.all([first, second])

  assert.equal(scans, 1)
  assert.deepEqual(firstPair, secondPair)
  assert.match(firstPair.databasePath, /db-collection-jobs\.sqlite$/)
  assert.match(firstPair.blobPath, /db-blobs-jobs\.sqlite$/)
})

test('catalog inputs are validated before filesystem access', async () => {
  assert.throws(() => new StorageCatalog(''), /storagePath.*non-empty/i)
  assert.throws(() => new StorageCatalog(':memory:'), /filesystem storage/i)
  assert.throws(() => new StorageCatalog('./data', null), /dependencies.*object/i)

  let scans = 0
  const catalog = new StorageCatalog('./data', {
    async readDirectory() {
      scans++
      return []
    },
  })
  assert.throws(() => catalog.resolvePair('../unsafe'), /only letters/i)
  await assert.rejects(catalog.resolvePair('safe', { create: 'yes' }), /create option.*boolean/i)
  await assert.rejects(catalog.listPairs({ refresh: 'yes' }), /refresh option.*boolean/i)
  assert.equal(scans, 0)
})

test('matching symlinks and non-file entries are rejected', async (context) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-catalog-unsafe-'))
  context.after(() => rm(storagePath, { recursive: true, force: true }))
  const target = path.join(storagePath, 'target.sqlite')
  await writeFile(target, '')
  try {
    await symlink(target, path.join(storagePath, 'db-collection-users.sqlite'))
  } catch (error) {
    if (error.code === 'EPERM') return
    throw error
  }
  await writeFile(path.join(storagePath, 'db-blobs-users.sqlite'), '')

  await assert.rejects(
    new StorageCatalog(storagePath).resolvePair('users', { create: false }),
    (error) => error instanceof StorageCatalogError &&
      error.code === 'IDB_UNSAFE_COLLECTION_FILE',
  )
})

test('engines can share and release one process-local catalog', () => {
  const storagePath = path.join(os.tmpdir(), `node-idb-shared-catalog-${process.pid}`)
  const first = acquireStorageCatalog(storagePath)
  const second = acquireStorageCatalog(storagePath)
  assert.equal(second, first)
  releaseStorageCatalog(first)
  releaseStorageCatalog(second)

  const replacement = acquireStorageCatalog(storagePath)
  assert.notEqual(replacement, first)
  releaseStorageCatalog(replacement)
  assert.throws(() => releaseStorageCatalog(replacement), /already released|not acquired/i)
})
