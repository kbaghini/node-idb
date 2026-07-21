import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertBackupPathsDoNotOverlap,
  backupFormat,
  backupFormatVersion,
  backupManifestFilename,
  backupSqliteFile,
  checkSqliteIntegrity,
  createBackupFileMetadata,
  discardBackupStage,
  prepareBackupDestination,
  promoteBackupStage,
  readBackupManifest,
  writeBackupManifest,
} from '../src/idb/backup.js'
import {
  closeDatabase,
  exec as sqliteExec,
  get as sqliteGet,
  openDatabase,
} from '../src/idb/database.js'

async function temporaryDirectory(context, prefix = 'node-idb-backup-utils-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function exists(filename) {
  try {
    await access(filename)
    return true
  } catch {
    return false
  }
}

async function populateStage(stage, marker, collection = 'users') {
  const databaseFile = path.join(stage.stagingPath, `db-collection-${collection}.sqlite`)
  const blobFile = path.join(stage.stagingPath, `db-blobs-${collection}.sqlite`)
  const database = await openDatabase(databaseFile)
  await sqliteExec(database, `CREATE TABLE sentinel (value TEXT NOT NULL);
    INSERT INTO sentinel VALUES ('${marker.replaceAll("'", "''")}');`)
  await closeDatabase(database)
  const blobs = await openDatabase(blobFile)
  await sqliteExec(blobs, `CREATE TABLE sentinel (value TEXT NOT NULL);
    INSERT INTO sentinel VALUES ('${marker.replaceAll("'", "''")}');`)
  await closeDatabase(blobs)
  const files = await Promise.all([
    createBackupFileMetadata(databaseFile, { collection, kind: 'collection' }),
    createBackupFileMetadata(blobFile, { collection, kind: 'blobs' }),
  ])
  const manifest = await writeBackupManifest(stage.stagingPath, {
    nodeIdbVersion: marker,
    collections: [collection],
    files,
    createdAt: '2026-07-19T12:00:00.000Z',
  })
  return { databaseFile, blobFile, manifest, metadata: files[0], files }
}

test('backs up one SQLite file in steps and validates the resulting database', async (context) => {
  const root = await temporaryDirectory(context)
  const sourcePath = path.join(root, 'source.sqlite')
  const destinationPath = path.join(root, 'staging', 'copy.sqlite')
  const source = await openDatabase(sourcePath)
  await sqliteExec(source, `
    CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO records (value) VALUES ('first'), ('second');
  `)

  try {
    assert.equal(
      await backupSqliteFile(source, destinationPath, { pagesPerStep: 1 }),
      destinationPath,
    )
  } finally {
    await closeDatabase(source)
  }

  assert.deepEqual(await checkSqliteIntegrity(destinationPath), { mode: 'quick', result: 'ok' })
  assert.deepEqual(
    await checkSqliteIntegrity(destinationPath, { mode: 'full' }),
    { mode: 'full', result: 'ok' },
  )
  const copy = await openDatabase(destinationPath)
  assert.deepEqual(await sqliteGet(copy, 'SELECT count(*) AS count FROM records'), { count: 2 })
  await closeDatabase(copy)

  const reopened = await openDatabase(sourcePath)
  try {
    await assert.rejects(
      backupSqliteFile(reopened, destinationPath),
      /already exists/i,
    )
  } finally {
    await closeDatabase(reopened)
  }
})

test('retries SQLITE_BUSY and cooperatively aborts without leaving a partial file', async (context) => {
  const root = await temporaryDirectory(context)
  const successfulPath = path.join(root, 'retried.sqlite')
  let steps = 0
  let finishes = 0
  const retryingDatabase = {
    backup(filename, initialized) {
      const backup = {
        completed: false,
        failed: false,
        retryErrors: [],
        step(_pages, callback) {
          steps++
          if (steps < 3) {
            const error = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY', errno: 5 })
            queueMicrotask(() => callback(error))
            return
          }
          writeFile(filename, 'complete').then(() => {
            backup.completed = true
            callback(null, true)
          }, callback)
        },
        finish(callback) {
          finishes++
          queueMicrotask(callback)
        },
      }
      queueMicrotask(() => initialized(null))
      return backup
    },
  }

  await backupSqliteFile(
    /** @type {import('sqlite3').Database} */ (/** @type {unknown} */ (retryingDatabase)),
    successfulPath,
    { retryDelayMs: 1, busyTimeoutMs: 100 },
  )
  assert.equal(await readFile(successfulPath, 'utf8'), 'complete')
  assert.equal(steps, 3)
  assert.equal(finishes, 1)

  const abortedPath = path.join(root, 'aborted.sqlite')
  const controller = new AbortController()
  let abortedFinishes = 0
  const alwaysBusyDatabase = {
    backup(_filename, initialized) {
      const backup = {
        completed: false,
        failed: false,
        retryErrors: [],
        step(_pages, callback) {
          const error = Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED', errno: 6 })
          queueMicrotask(() => callback(error))
        },
        finish(callback) {
          abortedFinishes++
          queueMicrotask(callback)
        },
      }
      queueMicrotask(() => initialized(null))
      return backup
    },
  }
  setTimeout(() => controller.abort('test cancellation'), 10)
  await assert.rejects(
    backupSqliteFile(
      /** @type {import('sqlite3').Database} */ (/** @type {unknown} */ (alwaysBusyDatabase)),
      abortedPath,
      { retryDelayMs: 50, busyTimeoutMs: 1_000, signal: controller.signal },
    ),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  )
  assert.equal(abortedFinishes, 1)
  assert.equal(await exists(abortedPath), false)
})

test('rejects lexical and physical backup path overlap', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const sibling = path.join(root, 'destination')
  await mkdir(source)

  await assert.rejects(
    assertBackupPathsDoNotOverlap(source, path.join(source, 'backup')),
    /must not overlap/i,
  )
  await assert.rejects(
    assertBackupPathsDoNotOverlap(path.join(source, 'nested'), source),
    /must not overlap/i,
  )
  await assert.doesNotReject(assertBackupPathsDoNotOverlap(source, sibling))
  await assert.doesNotReject(assertBackupPathsDoNotOverlap(':memory:', sibling))
})

test('writes deterministic hash metadata and a recognized manifest', async (context) => {
  const root = await temporaryDirectory(context)
  const filename = path.join(root, 'db-collection-users.sqlite')
  const blobFilename = path.join(root, 'db-blobs-users.sqlite')
  const database = await openDatabase(filename)
  await sqliteExec(database, "CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('metadata payload')")
  await closeDatabase(database)
  const blobs = await openDatabase(blobFilename)
  await sqliteExec(blobs, "CREATE TABLE records (value BLOB); INSERT INTO records VALUES (x'010203')")
  await closeDatabase(blobs)
  const content = await readFile(filename)
  const metadata = await createBackupFileMetadata(filename, {
    collection: 'users',
    kind: 'collection',
  })
  assert.deepEqual(metadata, {
    collection: 'users',
    kind: 'collection',
    filename: 'db-collection-users.sqlite',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  })
  const blobMetadata = await createBackupFileMetadata(blobFilename, {
    collection: 'users',
    kind: 'blobs',
  })

  const manifest = await writeBackupManifest(root, {
    nodeIdbVersion: '0.2.0-test',
    collections: ['users'],
    files: [metadata, blobMetadata],
    createdAt: '2026-07-19T12:00:00.000Z',
    sqliteVersion: 'test-sqlite',
  })
  assert.equal(manifest.format, backupFormat)
  assert.equal(manifest.formatVersion, backupFormatVersion)
  assert.deepEqual(await readBackupManifest(root), manifest)
  assert.match(await readFile(path.join(root, backupManifestFilename), 'utf8'), /"per-collection"/)
})

test('promotes a staged backup without exposing a partial destination', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)
  const stage = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  await populateStage(stage, 'first')
  assert.equal(await exists(destination), false)

  assert.deepEqual(await promoteBackupStage(stage), {
    destinationPath: destination,
    replaced: false,
  })
  assert.equal((await readBackupManifest(destination)).nodeIdbVersion, 'first')
  assert.equal(await exists(stage.stagingPath), false)
})

test('failed stage cleanup preserves the stage identity for a reported retry', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)
  const stage = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  await populateStage(stage, 'cleanup-retry')
  const cleanupFailure = new Error('injected cleanup failure')

  await assert.rejects(
    discardBackupStage(stage, { rm: async () => { throw cleanupFailure } }),
    cleanupFailure,
  )
  assert.equal(await exists(stage.stagingPath), true)
  await discardBackupStage(stage)
  assert.equal(await exists(stage.stagingPath), false)
})

test('overwrite requires a recognized manifest and detects destination races', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)
  await mkdir(destination)
  await writeFile(path.join(destination, 'user-file.txt'), 'keep me')

  await assert.rejects(
    prepareBackupDestination({ sourcePath: source, destinationPath: destination }),
    /already exists/i,
  )
  await assert.rejects(
    prepareBackupDestination({ sourcePath: source, destinationPath: destination, overwrite: true }),
    /recognized node-idb backup|manifest/i,
  )
  assert.equal(await readFile(path.join(destination, 'user-file.txt'), 'utf8'), 'keep me')

  await rm(destination, { recursive: true })
  const initial = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  await populateStage(initial, 'initial')
  await promoteBackupStage(initial)

  const replacement = await prepareBackupDestination({
    sourcePath: source,
    destinationPath: destination,
    overwrite: true,
  })
  await populateStage(replacement, 'replacement')
  const manifestPath = path.join(destination, backupManifestFilename)
  const changed = JSON.parse(await readFile(manifestPath, 'utf8'))
  changed.createdAt = '2026-07-19T12:00:01.000Z'
  await writeFile(manifestPath, `${JSON.stringify(changed, null, 2)}\n`)

  await assert.rejects(promoteBackupStage(replacement), /changed after staging began/i)
  assert.equal((await readBackupManifest(destination)).nodeIdbVersion, 'initial')
  await discardBackupStage(replacement)
})

test('overwrite verifies every manifested file and preserves newly added files', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)

  const initial = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  const { metadata } = await populateStage(initial, 'initial')
  await promoteBackupStage(initial)

  const modifiedFileStage = await prepareBackupDestination({
    sourcePath: source,
    destinationPath: destination,
    overwrite: true,
  })
  await populateStage(modifiedFileStage, 'replacement-one')
  const databasePath = path.join(destination, metadata.filename)
  const originalDatabase = await readFile(databasePath)
  await writeFile(databasePath, 'changed without updating the manifest')
  await assert.rejects(
    promoteBackupStage(modifiedFileStage),
    /failed verification/i,
  )
  assert.equal(await readFile(databasePath, 'utf8'), 'changed without updating the manifest')
  await discardBackupStage(modifiedFileStage)

  // Restore the manifested bytes so a second overwrite can begin, then inject
  // an untracked file immediately after the destination directory is renamed.
  await writeFile(databasePath, originalDatabase)
  const untrackedFileStage = await prepareBackupDestination({
    sourcePath: source,
    destinationPath: destination,
    overwrite: true,
  })
  await populateStage(untrackedFileStage, 'replacement-two')
  let injected = false
  const renameWithUntrackedFile = async (from, to) => {
    await rename(from, to)
    if (!injected && path.resolve(from) === destination) {
      injected = true
      await writeFile(path.join(to, 'do-not-delete.txt'), 'preserve this file')
    }
  }

  await assert.rejects(
    promoteBackupStage(untrackedFileStage, { rename: renameWithUntrackedFile }),
    /missing, renamed, or untracked files/i,
  )
  assert.equal(await readFile(path.join(destination, 'do-not-delete.txt'), 'utf8'), 'preserve this file')
  assert.equal(await exists(untrackedFileStage.stagingPath), true)
  await discardBackupStage(untrackedFileStage)
})

test('restores the previous recognized backup when promotion fails', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)

  const initial = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  await populateStage(initial, 'initial')
  await promoteBackupStage(initial)

  const replacement = await prepareBackupDestination({
    sourcePath: source,
    destinationPath: destination,
    overwrite: true,
  })
  await populateStage(replacement, 'replacement')
  let injected = false
  const renameWithFailure = async (from, to) => {
    if (!injected && path.resolve(from) === replacement.stagingPath && path.resolve(to) === destination) {
      injected = true
      throw new Error('injected promotion failure')
    }
    return rename(from, to)
  }

  await assert.rejects(
    promoteBackupStage(replacement, { rename: renameWithFailure }),
    /injected promotion failure/,
  )
  assert.equal((await readBackupManifest(destination)).nodeIdbVersion, 'initial')
  assert.equal(await exists(replacement.stagingPath), true)

  assert.deepEqual(await promoteBackupStage(replacement), {
    destinationPath: destination,
    replaced: true,
  })
  assert.equal((await readBackupManifest(destination)).nodeIdbVersion, 'replacement')
})

test('a promoted backup preserves the original retained-sibling cleanup error', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)

  const initial = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  await populateStage(initial, 'initial')
  await promoteBackupStage(initial)

  const replacement = await prepareBackupDestination({
    sourcePath: source,
    destinationPath: destination,
    overwrite: true,
  })
  await populateStage(replacement, 'replacement')
  const injected = new Error('injected retained-backup cleanup failure')
  let failure
  try {
    await promoteBackupStage(replacement, { rm: async () => { throw injected } })
  } catch (error) {
    failure = error
  }

  assert.match(String(failure), /promoted.*previous backup could not be removed/i)
  assert.equal(failure?.cause, injected)
  assert.equal((await readBackupManifest(destination)).nodeIdbVersion, 'replacement')
  assert.equal(await exists(replacement.stagingPath), false)

  // This is the same cleanup call made by the public backup() catch path. It
  // must be a harmless no-op after the staging directory was promoted, not a
  // misleading "unrecognized stage" error that obscures the real failure.
  await discardBackupStage(replacement)
})

test('post-rename verification quarantines a changed publication and restores the old backup', async (context) => {
  const root = await temporaryDirectory(context)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'backup')
  await mkdir(source)

  const initial = await prepareBackupDestination({ sourcePath: source, destinationPath: destination })
  await populateStage(initial, 'initial')
  await promoteBackupStage(initial)

  const replacement = await prepareBackupDestination({
    sourcePath: source,
    destinationPath: destination,
    overwrite: true,
  })
  await populateStage(replacement, 'replacement')
  let injected = false
  const renameThenCorrupt = async (from, to) => {
    await rename(from, to)
    if (!injected && path.resolve(from) === replacement.stagingPath) {
      injected = true
      await writeFile(path.join(to, 'db-collection-users.sqlite'), 'post-rename corruption')
    }
  }

  let failure
  try {
    await promoteBackupStage(replacement, { rename: renameThenCorrupt })
  } catch (error) {
    failure = error
  }
  assert.match(String(failure), /failed verification.*retained for inspection/i)
  assert.equal((await readBackupManifest(destination)).nodeIdbVersion, 'initial')
  const rejectedPath = /at (.+)$/.exec(String(failure))?.[1]
  assert.ok(rejectedPath)
  assert.equal(await readFile(path.join(rejectedPath, 'db-collection-users.sqlite'), 'utf8'), 'post-rename corruption')
  await discardBackupStage(replacement)
})

test('integrity checks reject non-database files and abort before opening', async (context) => {
  const root = await temporaryDirectory(context)
  const corrupt = path.join(root, 'corrupt.sqlite')
  await writeFile(corrupt, 'not a sqlite database')
  await assert.rejects(checkSqliteIntegrity(corrupt), /not a database|file is not a database/i)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    checkSqliteIntegrity(corrupt, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  )
})
