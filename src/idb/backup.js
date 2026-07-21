// @ts-check

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'

import sqlite3 from 'sqlite3'

export const backupManifestFilename = '.node-idb-backup.json'
export const backupFormat = 'node-idb-backup'
export const backupFormatVersion = 1

const stagePrefix = '.node-idb-backup-stage-'
const previousPrefix = '.node-idb-backup-previous-'
const failedPrefix = '.node-idb-backup-failed-'
const collectionNamePattern = /^(?=.{1,128}$)(?=.*[a-z0-9_])[a-z0-9_-]+$/
/** @type {WeakSet<object>} */
const preparedStages = new WeakSet()

/**
 * The sqlite3 package exposes Backup at runtime but omits it from its bundled
 * TypeScript declarations.
 * @typedef {{
 *   completed: boolean,
 *   failed: boolean,
 *   retryErrors: number[],
 *   step: (pages: number, callback: (error: NodeJS.ErrnoException | null, completed?: boolean) => void) => void,
 *   finish: (callback: () => void) => void,
 * }} SqliteBackup
 */

/**
 * @typedef {{
 *   destinationPath: string,
 *   parentPath: string,
 *   stagingPath: string,
 *   overwrite: boolean,
 *   expectedDestination: 'absent' | 'recognized',
 *   destinationManifestSha256: string | null,
 * }} BackupStage
 */

/**
 * @typedef {{
 *   collection: string,
 *   kind: 'collection' | 'blobs',
 *   filename: string,
 *   bytes: number,
 *   sha256: string,
 * }} BackupFileMetadata
 */

/** @param {unknown} value @param {string} label */
function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.length) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (value.includes('\0')) throw new TypeError(`${label} must not contain null bytes`)
}

/** @param {AbortSignal | undefined} signal */
function assertAbortSignal(signal) {
  if (
    signal !== undefined &&
    (
      !signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    )
  ) {
    throw new TypeError('signal must be an AbortSignal')
  }
}

/** @param {AbortSignal | undefined} signal */
function abortError(signal) {
  const error = new Error('The backup operation was aborted', signal?.reason === undefined
    ? undefined
    : { cause: signal.reason })
  error.name = 'AbortError'
  Object.defineProperty(error, 'code', { value: 'ABORT_ERR', enumerable: true })
  return error
}

/** @param {AbortSignal | undefined} signal */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

/** @param {number} milliseconds @param {AbortSignal | undefined} signal */
function delay(milliseconds, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(done, milliseconds)
    function done() {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', aborted)
      resolve(undefined)
    }
    function aborted() {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', aborted)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
  })
}

/** @param {unknown} error */
function isRetryableSqliteError(error) {
  const source = /** @type {NodeJS.ErrnoException & { errno?: number }} */ (error)
  const code = String(source?.code || '').toUpperCase()
  const errno = Number(source?.errno)
  return code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_') ||
    code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_LOCKED_') ||
    (Number.isInteger(errno) && ((errno & 0xff) === sqlite3.BUSY || (errno & 0xff) === sqlite3.LOCKED))
}

/** @param {SqliteBackup} backup */
function finishBackup(backup) {
  return new Promise((resolve, reject) => {
    try {
      backup.finish(() => resolve(undefined))
    } catch (error) {
      reject(error)
    }
  })
}

/** @param {SqliteBackup} backup @param {number} pages */
function stepBackup(backup, pages) {
  return new Promise((resolve, reject) => {
    try {
      backup.step(pages, (error, completed) => {
        if (error) reject(error)
        else resolve(Boolean(completed || backup.completed))
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Copies the `main` schema of one open sqlite3 Database to a new file. The
 * destination must not already exist; this keeps the low-level helper from
 * ever overwriting user data. BUSY and LOCKED are retried cooperatively.
 *
 * @param {import('sqlite3').Database} database
 * @param {string} destinationPath
 * @param {{
 *   busyTimeoutMs?: number,
 *   pagesPerStep?: number,
 *   retryDelayMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function backupSqliteFile(database, destinationPath, options = {}) {
  const {
    busyTimeoutMs = 10_000,
    pagesPerStep = 256,
    retryDelayMs = 25,
    signal,
  } = options
  assertNonEmptyString(destinationPath, 'destinationPath')
  assertAbortSignal(signal)
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2_147_483_647) {
    throw new RangeError('busyTimeoutMs must be an integer from 0 through 2147483647')
  }
  if (!Number.isSafeInteger(pagesPerStep) || pagesPerStep < 1) {
    throw new RangeError('pagesPerStep must be a positive integer')
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
    throw new RangeError('retryDelayMs must be an integer from 0 through 60000')
  }
  if (!database || typeof /** @type {any} */ (database).backup !== 'function') {
    throw new TypeError('database must be an open sqlite3 Database with backup support')
  }

  const resolvedDestination = path.resolve(destinationPath)
  await mkdir(path.dirname(resolvedDestination), { recursive: true })
  try {
    await lstat(resolvedDestination)
    throw new Error(`Backup destination file already exists: ${resolvedDestination}`)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  throwIfAborted(signal)

  /** @type {SqliteBackup | null} */
  let backup = null
  let completed = false
  try {
    backup = await new Promise((resolve, reject) => {
      /** @type {SqliteBackup} */
      let pending
      try {
        pending = /** @type {any} */ (database).backup(
          resolvedDestination,
          (error) => error ? reject(error) : resolve(pending),
        )
      } catch (error) {
        reject(error)
      }
    })
    backup.retryErrors = [sqlite3.BUSY, sqlite3.LOCKED]
    const deadline = Date.now() + busyTimeoutMs
    while (!completed) {
      throwIfAborted(signal)
      try {
        completed = /** @type {boolean} */ (await stepBackup(backup, pagesPerStep))
      } catch (error) {
        if (!isRetryableSqliteError(error) || Date.now() >= deadline) throw error
        await delay(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())), signal)
      }
    }
  } catch (error) {
    throw error
  } finally {
    if (backup) await finishBackup(backup).catch(() => {})
    if (!completed) await rm(resolvedDestination, { force: true }).catch(() => {})
  }
  const output = await lstat(resolvedDestination)
  if (!output.isFile() || output.isSymbolicLink()) {
    await rm(resolvedDestination, { force: true }).catch(() => {})
    throw new Error(`SQLite backup did not create a regular destination file: ${resolvedDestination}`)
  }
  return resolvedDestination
}

/** @param {string} candidate */
async function physicalPath(candidate) {
  const resolved = path.resolve(candidate)
  let existing = resolved
  /** @type {string[]} */
  const missing = []
  while (true) {
    try {
      const canonical = await realpath(existing)
      return path.join(canonical, ...missing)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
      const parent = path.dirname(existing)
      if (parent === existing) return resolved
      missing.unshift(path.basename(existing))
      existing = parent
    }
  }
}

/** @param {string} value */
function comparablePath(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** @param {string} parent @param {string} candidate */
function containsPath(parent, candidate) {
  const relative = path.relative(comparablePath(parent), comparablePath(candidate))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/**
 * Rejects equal, nested, and symlink-equivalent source/destination paths.
 *
 * @param {string} sourcePath
 * @param {string} destinationPath
 */
export async function assertBackupPathsDoNotOverlap(sourcePath, destinationPath) {
  assertNonEmptyString(sourcePath, 'sourcePath')
  assertNonEmptyString(destinationPath, 'destinationPath')
  if (sourcePath === ':memory:') return
  const source = await physicalPath(sourcePath)
  const destination = await physicalPath(destinationPath)
  if (containsPath(source, destination) || containsPath(destination, source)) {
    throw new Error('Backup source and destination paths must not overlap')
  }
}

/** @param {string} filename @param {AbortSignal | undefined} signal */
async function fileSha256(filename, signal) {
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const stream = createReadStream(filename, { signal })
    for await (const chunk of stream) {
      hash.update(chunk)
      bytes += chunk.length
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    throw error
  }
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Creates stable size/hash metadata for one staged database file.
 *
 * @param {string} filename
 * @param {{ collection: string, kind: 'collection' | 'blobs', signal?: AbortSignal }} options
 * @returns {Promise<BackupFileMetadata>}
 */
export async function createBackupFileMetadata(filename, { collection, kind, signal }) {
  assertNonEmptyString(filename, 'filename')
  assertNonEmptyString(collection, 'collection')
  if (kind !== 'collection' && kind !== 'blobs') {
    throw new TypeError('kind must be either "collection" or "blobs"')
  }
  assertAbortSignal(signal)
  throwIfAborted(signal)
  const entry = await lstat(filename)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Backup input must be a regular file: ${filename}`)
  }
  const result = await fileSha256(filename, signal)
  throwIfAborted(signal)
  const after = await stat(filename)
  if (!after.isFile() || after.size !== result.bytes || after.size !== entry.size) {
    throw new Error(`Backup file changed while it was being hashed: ${filename}`)
  }
  return Object.freeze({
    collection,
    kind,
    filename: path.basename(filename),
    ...result,
  })
}

/** @param {string} filename @param {number} mode */
function openReadonlyDatabase(filename, mode) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, mode, (error) => {
      if (error) reject(error)
      else resolve(database)
    })
  })
}

/** @param {import('sqlite3').Database} database */
function closeSqliteDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve(undefined))
  })
}

/**
 * Runs SQLite's built-in consistency check without opening the file writable.
 *
 * @param {string} filename
 * @param {{ mode?: 'quick' | 'full', signal?: AbortSignal }} [options]
 */
export async function checkSqliteIntegrity(filename, options = {}) {
  const { mode = 'quick', signal } = options
  assertNonEmptyString(filename, 'filename')
  assertAbortSignal(signal)
  if (mode !== 'quick' && mode !== 'full') {
    throw new TypeError('integrity mode must be either "quick" or "full"')
  }
  throwIfAborted(signal)
  const database = /** @type {import('sqlite3').Database} */ (await openReadonlyDatabase(
    path.resolve(filename),
    sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX,
  ))
  const aborted = () => {
    try {
      database.interrupt()
    } catch {
      // The query may have completed concurrently with cancellation.
    }
  }
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    throwIfAborted(signal)
    const pragma = mode === 'quick' ? 'quick_check' : 'integrity_check'
    const rows = await new Promise((resolve, reject) => {
      database.all(`PRAGMA ${pragma}`, (error, result) => error ? reject(error) : resolve(result))
    })
    throwIfAborted(signal)
    const messages = /** @type {Record<string, unknown>[]} */ (rows)
      .map((row) => String(Object.values(row)[0] ?? ''))
    if (messages.length !== 1 || messages[0].toLowerCase() !== 'ok') {
      throw new Error(`SQLite ${pragma} failed for ${filename}: ${messages.join('; ') || 'no result'}`)
    }
    return Object.freeze({ mode, result: 'ok' })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    throw error
  } finally {
    signal?.removeEventListener('abort', aborted)
    await closeSqliteDatabase(database).catch(() => {})
  }
}

/** @param {BackupFileMetadata} file */
function validateFileMetadata(file) {
  if (!file || typeof file !== 'object') throw new TypeError('manifest files must be objects')
  assertNonEmptyString(file.collection, 'manifest file collection')
  if (file.kind !== 'collection' && file.kind !== 'blobs') {
    throw new TypeError('manifest file kind must be either "collection" or "blobs"')
  }
  assertNonEmptyString(file.filename, 'manifest filename')
  if (path.basename(file.filename) !== file.filename || file.filename === '.' || file.filename === '..') {
    throw new Error('manifest filenames must not contain a path')
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new RangeError('manifest file bytes must be a non-negative safe integer')
  }
  if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
    throw new Error('manifest file sha256 must be a 64-character hexadecimal digest')
  }
}

/** @param {unknown} source */
function validateManifest(source) {
  const manifest = /** @type {Record<string, any>} */ (source)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Invalid node-idb backup manifest')
  }
  if (manifest.format !== backupFormat || manifest.formatVersion !== backupFormatVersion) {
    throw new Error('Directory is not a recognized node-idb backup')
  }
  assertNonEmptyString(manifest.createdAt, 'manifest createdAt')
  if (Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('manifest createdAt must be a date')
  assertNonEmptyString(manifest.nodeIdbVersion, 'manifest nodeIdbVersion')
  assertNonEmptyString(manifest.sqliteVersion, 'manifest sqliteVersion')
  if (manifest.consistency !== 'per-collection') {
    throw new Error('manifest consistency must be "per-collection"')
  }
  if (!Array.isArray(manifest.collections) || !manifest.collections.length || !manifest.collections.every(
    (collection) => typeof collection === 'string' && collectionNamePattern.test(collection),
  )) {
    throw new Error('manifest collections must be a non-empty array of canonical names')
  }
  if (new Set(manifest.collections).size !== manifest.collections.length) {
    throw new Error('manifest collections must not contain duplicates')
  }
  if (!Array.isArray(manifest.files)) throw new Error('manifest files must be an array')
  const filenames = new Set()
  const collections = new Set(manifest.collections)
  const representedPairs = new Set()
  for (const file of manifest.files) {
    validateFileMetadata(file)
    if (file.filename === backupManifestFilename) {
      throw new Error('manifest files must not use the reserved manifest filename')
    }
    if (filenames.has(file.filename)) {
      throw new Error(`manifest contains a duplicate filename: ${file.filename}`)
    }
    if (!collections.has(file.collection)) {
      throw new Error(`manifest file refers to an unlisted collection: ${file.collection}`)
    }
    const expectedFilename = file.kind === 'collection'
      ? `db-collection-${file.collection}.sqlite`
      : `db-blobs-${file.collection}.sqlite`
    if (file.filename !== expectedFilename) {
      throw new Error(
        `manifest file does not use its canonical node-idb filename: ${file.filename}`,
      )
    }
    const pairIdentity = `${file.collection}:${file.kind}`
    if (representedPairs.has(pairIdentity)) {
      throw new Error(`manifest contains duplicate ${file.kind} metadata for ${file.collection}`)
    }
    representedPairs.add(pairIdentity)
    filenames.add(file.filename)
  }
  for (const collection of manifest.collections) {
    if (
      !representedPairs.has(`${collection}:collection`) ||
      !representedPairs.has(`${collection}:blobs`)
    ) {
      throw new Error(`manifest must contain one collection/blob file pair for ${collection}`)
    }
  }
  if (manifest.files.length !== manifest.collections.length * 2) {
    throw new Error('manifest must contain exactly two files per collection')
  }
  return manifest
}

/**
 * Writes the recognition manifest last and exclusively within the private
 * staging directory.
 *
 * @param {string} directory
 * @param {{
 *   nodeIdbVersion: string,
 *   collections: string[],
 *   files: BackupFileMetadata[],
 *   createdAt?: string,
 *   sqliteVersion?: string,
 * }} details
 */
export async function writeBackupManifest(directory, details) {
  assertNonEmptyString(directory, 'directory')
  if (!details || typeof details !== 'object') throw new TypeError('manifest details are required')
  if (!Array.isArray(details.collections)) throw new TypeError('collections must be an array')
  if (!Array.isArray(details.files)) throw new TypeError('files must be an array')
  const manifest = validateManifest({
    format: backupFormat,
    formatVersion: backupFormatVersion,
    createdAt: details.createdAt || new Date().toISOString(),
    nodeIdbVersion: details.nodeIdbVersion,
    sqliteVersion: details.sqliteVersion || sqlite3.VERSION,
    consistency: 'per-collection',
    collections: [...details.collections].sort((left, right) => left.localeCompare(right)),
    files: [...details.files].sort((left, right) => left.filename.localeCompare(right.filename)),
  })
  const directoryEntry = await lstat(directory)
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new Error(`Backup staging path must be a real directory: ${directory}`)
  }
  const destination = path.join(directory, backupManifestFilename)
  const handle = await open(destination, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {})
    throw error
  }
  return Object.freeze(manifest)
}

/**
 * @param {string} directory
 * @param {{ signal?: AbortSignal, integrityCheck?: 'quick' | 'full' } | AbortSignal} [options]
 */
async function inspectBackupManifest(directory, options = {}) {
  const legacySignal = options && typeof options === 'object' && 'aborted' in options
  const settings = legacySignal
    ? {}
    : /** @type {{ signal?: AbortSignal, integrityCheck?: 'quick' | 'full' }} */ (options)
  const signal = legacySignal ? /** @type {AbortSignal} */ (options) : settings.signal
  const integrityCheck = legacySignal ? 'quick' : (settings.integrityCheck || 'quick')
  assertAbortSignal(signal)
  if (integrityCheck !== 'quick' && integrityCheck !== 'full') {
    throw new TypeError('integrityCheck must be either "quick" or "full"')
  }
  throwIfAborted(signal)
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Backup destination must be a real directory')
  }
  const filename = path.join(directory, backupManifestFilename)
  let manifestEntry
  try {
    manifestEntry = await lstat(filename)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new Error('Directory is not a recognized node-idb backup: manifest is missing', {
        cause: error,
      })
    }
    throw error
  }
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.size > 1_048_576) {
    throw new Error('Directory is not a recognized node-idb backup')
  }
  const source = await readFile(filename, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error('Invalid node-idb backup manifest JSON', { cause: error })
  }
  const manifest = validateManifest(parsed)
  const expectedEntries = [
    backupManifestFilename,
    ...manifest.files.map((file) => file.filename),
  ].sort((left, right) => left.localeCompare(right))
  const assertExactEntries = async () => {
    throwIfAborted(signal)
    const actualEntries = (await readdir(directory))
      .sort((left, right) => left.localeCompare(right))
    if (
      actualEntries.length !== expectedEntries.length ||
      actualEntries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      throw new Error(
        'Recognized node-idb backup contains missing, renamed, or untracked files',
      )
    }
    throwIfAborted(signal)
  }
  await assertExactEntries()
  for (const expected of manifest.files) {
    const verifiedPath = path.join(directory, expected.filename)
    const actual = await createBackupFileMetadata(
      verifiedPath,
      { collection: expected.collection, kind: expected.kind, signal },
    )
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256.toLowerCase()) {
      throw new Error(`Recognized node-idb backup file failed verification: ${expected.filename}`)
    }
    await checkSqliteIntegrity(verifiedPath, { mode: integrityCheck, signal })
  }
  // Detect entries added or removed while the manifested files were hashed.
  await assertExactEntries()
  return {
    manifest,
    sha256: createHash('sha256').update(source).digest('hex'),
  }
}

/** @param {string} directory */
export async function readBackupManifest(directory) {
  assertNonEmptyString(directory, 'directory')
  return Object.freeze((await inspectBackupManifest(path.resolve(directory))).manifest)
}

/**
 * Fully verifies a manifested backup without modifying it.
 * @param {{ backupPath: string, integrityCheck?: 'quick' | 'full', signal?: AbortSignal }} options
 */
export async function verifyBackup(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('verifyBackup requires an options object')
  }
  const unknown = Object.keys(options).filter(
    (key) => !['backupPath', 'integrityCheck', 'signal'].includes(key),
  )
  if (unknown.length) throw new TypeError(`Unknown verifyBackup option: ${unknown.join(', ')}`)
  const { backupPath, integrityCheck = 'quick', signal } = options
  assertNonEmptyString(backupPath, 'backupPath')
  const resolvedPath = path.resolve(backupPath)
  const inspection = await inspectBackupManifest(resolvedPath, { integrityCheck, signal })
  return Object.freeze({
    backupPath: resolvedPath,
    manifestSha256: inspection.sha256,
    integrityCheck,
    createdAt: inspection.manifest.createdAt,
    nodeIdbVersion: inspection.manifest.nodeIdbVersion,
    sqliteVersion: inspection.manifest.sqliteVersion,
    collections: Object.freeze([...inspection.manifest.collections]),
    files: Object.freeze(inspection.manifest.files.map((file) => Object.freeze({ ...file }))),
  })
}

/**
 * Restores a verified backup into a new directory, or replaces only a
 * previously manifested node-idb backup/restore directory when overwrite is
 * explicit. Arbitrary directories are never removed or replaced.
 * @param {{
 *   backupPath: string,
 *   destinationPath: string,
 *   overwrite?: boolean,
 *   integrityCheck?: 'quick' | 'full',
 *   signal?: AbortSignal,
 * }} options
 */
export async function restoreBackup(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('restoreBackup requires an options object')
  }
  const unknown = Object.keys(options).filter(
    (key) => !['backupPath', 'destinationPath', 'overwrite', 'integrityCheck', 'signal'].includes(key),
  )
  if (unknown.length) throw new TypeError(`Unknown restoreBackup option: ${unknown.join(', ')}`)
  const {
    backupPath,
    destinationPath,
    overwrite = false,
    integrityCheck = 'quick',
    signal,
  } = options
  assertNonEmptyString(backupPath, 'backupPath')
  assertNonEmptyString(destinationPath, 'destinationPath')
  if (typeof overwrite !== 'boolean') throw new TypeError('overwrite must be a boolean')
  const sourcePath = path.resolve(backupPath)
  const source = await inspectBackupManifest(sourcePath, { integrityCheck, signal })
  const stage = await prepareBackupDestination({
    sourcePath,
    destinationPath,
    overwrite,
    signal,
  })
  try {
    for (const file of source.manifest.files) {
      throwIfAborted(signal)
      await copyFile(
        path.join(sourcePath, file.filename),
        path.join(stage.stagingPath, file.filename),
        constants.COPYFILE_EXCL,
      )
    }
    await writeBackupManifest(stage.stagingPath, {
      nodeIdbVersion: source.manifest.nodeIdbVersion,
      collections: [...source.manifest.collections],
      files: source.manifest.files.map((file) => ({ ...file })),
      createdAt: source.manifest.createdAt,
      sqliteVersion: source.manifest.sqliteVersion,
    })
    await inspectBackupManifest(stage.stagingPath, { integrityCheck, signal })
    const promotion = await promoteBackupStage(stage, { signal })
    return Object.freeze({
      backupPath: sourcePath,
      destinationPath: promotion.destinationPath,
      replaced: promotion.replaced,
      integrityCheck,
      collections: Object.freeze([...source.manifest.collections]),
      files: Object.freeze(source.manifest.files.map((file) => Object.freeze({ ...file }))),
    })
  } catch (error) {
    try {
      await discardBackupStage(stage)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Restore failed and its staging directory could not be removed: ${stage.stagingPath}`,
      )
    }
    throw error
  }
}

/**
 * Validates the destination without modifying it, then creates a unique
 * sibling staging directory.
 *
 * @param {{
 *   sourcePath: string,
 *   destinationPath: string,
 *   overwrite?: boolean,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<Readonly<BackupStage>>}
 */
export async function prepareBackupDestination({
  sourcePath,
  destinationPath,
  overwrite = false,
  signal,
}) {
  assertNonEmptyString(sourcePath, 'sourcePath')
  assertNonEmptyString(destinationPath, 'destinationPath')
  if (typeof overwrite !== 'boolean') throw new TypeError('overwrite must be a boolean')
  assertAbortSignal(signal)
  throwIfAborted(signal)
  const resolvedDestination = path.resolve(destinationPath)
  if (resolvedDestination === path.parse(resolvedDestination).root) {
    throw new Error('Backup destination must not be a filesystem root')
  }
  await assertBackupPathsDoNotOverlap(sourcePath, resolvedDestination)
  const parentPath = path.dirname(resolvedDestination)
  await mkdir(parentPath, { recursive: true })
  await assertBackupPathsDoNotOverlap(sourcePath, resolvedDestination)
  throwIfAborted(signal)

  /** @type {'absent' | 'recognized'} */
  let expectedDestination = 'absent'
  /** @type {string | null} */
  let destinationManifestSha256 = null
  let destinationExists = false
  try {
    await lstat(resolvedDestination)
    destinationExists = true
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  if (destinationExists) {
    if (!overwrite) throw new Error(`Backup destination already exists: ${resolvedDestination}`)
    const inspection = await inspectBackupManifest(resolvedDestination, signal)
    expectedDestination = 'recognized'
    destinationManifestSha256 = inspection.sha256
  }

  const stagingPath = await mkdtemp(path.join(parentPath, stagePrefix))
  const stage = Object.freeze({
    destinationPath: resolvedDestination,
    parentPath,
    stagingPath,
    overwrite,
    expectedDestination,
    destinationManifestSha256,
  })
  preparedStages.add(stage)
  return stage
}

/** @param {BackupStage} stage */
function validateStage(stage) {
  if (!stage || typeof stage !== 'object') throw new TypeError('A backup stage is required')
  if (!preparedStages.has(stage)) throw new Error('Unrecognized backup stage')
  const parentPath = path.resolve(stage.parentPath)
  const destinationPath = path.resolve(stage.destinationPath)
  const stagingPath = path.resolve(stage.stagingPath)
  if (path.dirname(destinationPath) !== parentPath || path.dirname(stagingPath) !== parentPath) {
    throw new Error('Invalid backup stage paths')
  }
  if (!path.basename(stagingPath).startsWith(stagePrefix) || stagingPath === destinationPath) {
    throw new Error('Invalid backup staging directory')
  }
  return { parentPath, destinationPath, stagingPath }
}

/**
 * Removes only a staging directory created by prepareBackupDestination().
 *
 * @param {BackupStage} stage
 * @param {{ rm?: typeof rm }} [_operations]
 */
export async function discardBackupStage(stage, _operations = {}) {
  const remove = _operations.rm || rm
  const { stagingPath } = validateStage(stage)
  await remove(stagingPath, { recursive: true, force: true })
  preparedStages.delete(stage)
}

/**
 * Promotes a complete staged backup. Existing destinations are moved aside
 * only when prepareBackupDestination() recognized their manifest, and are
 * restored if the staging rename fails.
 *
 * `_operations` exists so rollback paths can be deterministically tested; it
 * is not required by engine callers.
 *
 * @param {BackupStage} stage
 * @param {{ rename?: typeof rename, rm?: typeof rm, signal?: AbortSignal }} [_operations]
 */
export async function promoteBackupStage(stage, _operations = {}) {
  const operations = {
    rename: _operations.rename || rename,
    rm: _operations.rm || rm,
  }
  const { signal } = _operations
  assertAbortSignal(signal)
  const { destinationPath, parentPath, stagingPath } = validateStage(stage)
  const stagedInspection = await inspectBackupManifest(stagingPath, signal)

  if (stage.expectedDestination === 'recognized') {
    if (!stage.overwrite || !stage.destinationManifestSha256) {
      throw new Error('Invalid overwrite backup stage')
    }
    const current = await inspectBackupManifest(destinationPath, signal)
    if (current.sha256 !== stage.destinationManifestSha256) {
      throw new Error('Backup destination changed after staging began')
    }
  } else {
    try {
      await lstat(destinationPath)
      throw new Error('Backup destination appeared after staging began')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
  }

  // Cancellation is cooperative until this final point. Once directory
  // promotion starts, it must finish or roll back atomically.
  throwIfAborted(signal)
  const previousPath = path.join(parentPath, `${previousPrefix}${randomUUID()}`)
  const failedPath = path.join(parentPath, `${failedPrefix}${randomUUID()}`)
  let displaced = false
  let promoted = false
  try {
    if (stage.expectedDestination === 'recognized') {
      await operations.rename(destinationPath, previousPath)
      displaced = true
      const displacedCurrent = await inspectBackupManifest(previousPath)
      if (displacedCurrent.sha256 !== stage.destinationManifestSha256) {
        throw new Error('Backup destination changed while it was being claimed')
      }
    }
    await operations.rename(stagingPath, destinationPath)
    promoted = true
    const published = await inspectBackupManifest(destinationPath)
    if (published.sha256 !== stagedInspection.sha256) {
      throw new Error('Published backup manifest changed during promotion')
    }
  } catch (promotionError) {
    if (promoted) {
      let quarantined = false
      try {
        await operations.rename(destinationPath, failedPath)
        promoted = false
        quarantined = true
        if (displaced) {
          await operations.rename(previousPath, destinationPath)
          displaced = false
        }
      } catch (recoveryError) {
        throw new AggregateError(
          [promotionError, recoveryError],
          `Published backup validation and recovery failed; inspect destination ${destinationPath}, previous backup ${previousPath}, and rejected backup ${failedPath}`,
        )
      }
      throw new Error(
        quarantined
          ? `Published backup failed verification and was retained for inspection at ${failedPath}`
          : 'Published backup failed verification',
        { cause: promotionError },
      )
    }
    if (displaced && !promoted) {
      try {
        await operations.rename(previousPath, destinationPath)
        displaced = false
      } catch (rollbackError) {
        throw new AggregateError(
          [promotionError, rollbackError],
          `Backup promotion and rollback failed; previous backup remains at ${previousPath}`,
        )
      }
    }
    throw promotionError
  }

  if (displaced) {
    try {
      const displacedCurrent = await inspectBackupManifest(previousPath)
      if (displacedCurrent.sha256 !== stage.destinationManifestSha256) {
        throw new Error(
          `Previous backup changed after promotion and remains at ${previousPath}`,
        )
      }
      await operations.rm(previousPath, { recursive: true, force: true })
    } catch (error) {
      throw new Error(
        `Backup was promoted, but the previous backup could not be removed: ${previousPath}`,
        { cause: error },
      )
    }
  }
  preparedStages.delete(stage)
  return Object.freeze({ destinationPath, replaced: stage.expectedDestination === 'recognized' })
}
