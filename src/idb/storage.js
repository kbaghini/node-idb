// @ts-check

import {
  lstat as inspectFile,
  mkdir as makeDirectory,
  readdir as readDirectory,
} from 'node:fs/promises'
import path from 'node:path'

const databasePrefix = 'db-collection-'
const blobPrefix = 'db-blobs-'
const databaseSuffix = '.sqlite'
const collectionPattern = /^(?=.{1,128}$)(?=.*[A-Za-z0-9_])[A-Za-z0-9_-]+$/
/** @type {Map<string, { catalog: StorageCatalog, references: number }>} */
const sharedCatalogs = new Map()

/**
 * @typedef {{
 *   collection: string,
 *   databasePath: string,
 *   blobPath: string,
 *   existing: boolean,
 * }} CollectionFilePair
 *
 * @typedef {{
 *   databaseNames: Set<string>,
 *   blobNames: Set<string>,
 * }} CatalogEntry
 *
 * @typedef {{
 *   databaseName: string,
 *   blobName: string,
 * }} CatalogReservation
 *
 * @typedef {{
 *   inspectFile?: typeof inspectFile,
 *   readDirectory?: typeof readDirectory,
 *   makeDirectory?: typeof makeDirectory,
 * }} StorageCatalogDependencies
 */

/**
 * An error caused by an unsafe collection-file layout.
 */
export class StorageCatalogError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, collection: string, files: string[] }} details
   */
  constructor(message, { code, collection, files }) {
    super(message)
    this.name = 'StorageCatalogError'
    this.code = code
    this.collection = collection
    this.files = Object.freeze([...files])
  }
}

/** @param {unknown} error */
function isMissingDirectory(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT',
  )
}

/** @param {string} collection */
function collectionIdentity(collection) {
  if (typeof collection !== 'string' || !collection.length) {
    throw new TypeError('collection must be a non-empty string')
  }
  if (!collectionPattern.test(collection)) {
    throw new Error('collection may contain only letters, numbers, underscores and hyphens')
  }
  return collection.toLowerCase()
}

/**
 * Extracts a supported collection file without accepting journals, temporary
 * files, or names which could escape the storage directory.
 * @param {string} filename
 */
function parseCollectionFilename(filename) {
  const lower = filename.toLowerCase()
  if (!lower.endsWith(databaseSuffix)) return null

  let kind
  let prefix
  if (lower.startsWith(databasePrefix)) {
    kind = 'database'
    prefix = databasePrefix
  } else if (lower.startsWith(blobPrefix)) {
    kind = 'blob'
    prefix = blobPrefix
  } else {
    return null
  }

  const collection = filename.slice(prefix.length, -databaseSuffix.length)
  if (!collectionPattern.test(collection)) return null
  return { kind, collection: collection.toLowerCase() }
}

/**
 * Lazily indexes the collection files in one storage directory.
 *
 * The first resolution or listing performs one asynchronous directory scan.
 * Further resolutions are O(1) until `refresh()` or a listing with
 * `{ refresh: true }` explicitly asks for a new filesystem snapshot.
 */
export class StorageCatalog {
  /**
   * @param {string} storagePath
   * @param {StorageCatalogDependencies} [dependencies]
   */
  constructor(storagePath, dependencies = {}) {
    if (typeof storagePath !== 'string' || !storagePath.length) {
      throw new TypeError('storagePath must be a non-empty string')
    }
    if (storagePath === ':memory:') {
      throw new TypeError('StorageCatalog is only available for filesystem storage paths')
    }
    if (storagePath.includes('\0')) {
      throw new TypeError('storagePath must not contain null bytes')
    }
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies)
    ) {
      throw new TypeError('StorageCatalog dependencies must be an object')
    }
    if (
      dependencies.inspectFile !== undefined &&
      typeof dependencies.inspectFile !== 'function'
    ) {
      throw new TypeError('inspectFile dependency must be a function')
    }
    if (
      dependencies.readDirectory !== undefined &&
      typeof dependencies.readDirectory !== 'function'
    ) {
      throw new TypeError('readDirectory dependency must be a function')
    }
    if (
      dependencies.makeDirectory !== undefined &&
      typeof dependencies.makeDirectory !== 'function'
    ) {
      throw new TypeError('makeDirectory dependency must be a function')
    }

    this.storagePath = path.resolve(storagePath)
    this.inspectFile = dependencies.inspectFile || inspectFile
    this.readDirectory = dependencies.readDirectory || readDirectory
    this.makeDirectory = dependencies.makeDirectory || makeDirectory
    /** @type {Map<string, CatalogEntry>} */
    this.entries = new Map()
    /** @type {Map<string, CatalogReservation>} */
    this.reservations = new Map()
    this.loaded = false
    /** @type {Promise<void>} */
    this.queue = Promise.resolve()
  }

  /**
   * Serializes scans and reservations so concurrent first access cannot select
   * different paths within one catalog.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  enqueue(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Replaces the cached filesystem snapshot. Call only while queued. */
  async scan() {
    /** @type {import('node:fs').Dirent[]} */
    let directoryEntries
    try {
      directoryEntries = await this.readDirectory(this.storagePath, { withFileTypes: true })
    } catch (error) {
      if (!isMissingDirectory(error)) throw error
      directoryEntries = []
    }

    /** @type {Map<string, CatalogEntry>} */
    const entries = new Map()
    for (const directoryEntry of directoryEntries) {
      const filename = String(directoryEntry.name)
      const parsed = parseCollectionFilename(filename)
      if (!parsed) continue
      if (
        typeof directoryEntry.isFile === 'function' &&
        (!directoryEntry.isFile() || directoryEntry.isSymbolicLink?.())
      ) {
        throw new StorageCatalogError(
          `Collection storage entry must be a regular file: ${filename}`,
          {
            code: 'IDB_UNSAFE_COLLECTION_FILE',
            collection: parsed.collection,
            files: [filename],
          },
        )
      }
      let entry = entries.get(parsed.collection)
      if (!entry) {
        entry = { databaseNames: new Set(), blobNames: new Set() }
        entries.set(parsed.collection, entry)
      }
      if (parsed.kind === 'database') entry.databaseNames.add(filename)
      else entry.blobNames.add(filename)
    }

    this.entries = entries
    this.loaded = true

    // A complete pair confirms a prior lowercase reservation. Incomplete and
    // ambiguous layouts remain visible so validation can fail safely.
    for (const [identity, reservation] of this.reservations) {
      const entry = entries.get(identity)
      if (entry?.databaseNames.size === 1 && entry.blobNames.size === 1) {
        this.reservations.delete(identity)
      } else {
        this.reservations.set(identity, reservation)
      }
    }
  }

  /** Call only while queued. */
  async ensureLoaded() {
    if (!this.loaded) await this.scan()
  }

  /**
   * @param {string} identity
   * @param {CatalogEntry | undefined} entry
   * @returns {CollectionFilePair | null}
   */
  pairFromEntry(identity, entry) {
    if (!entry || (!entry.databaseNames.size && !entry.blobNames.size)) return null

    const databaseNames = [...entry.databaseNames].sort()
    const blobNames = [...entry.blobNames].sort()
    if (databaseNames.length > 1 || blobNames.length > 1) {
      const files = [...databaseNames, ...blobNames].sort()
      throw new StorageCatalogError(
        `Several database files differ only by collection-name casing for ${identity}: ${files.join(', ')}`,
        { code: 'IDB_AMBIGUOUS_COLLECTION_FILES', collection: identity, files },
      )
    }
    if (databaseNames.length !== blobNames.length) {
      const files = [...databaseNames, ...blobNames]
      const missing = databaseNames.length ? 'blob' : 'collection'
      throw new StorageCatalogError(
        `Collection ${identity} has an orphaned file; its matching ${missing} database is missing`,
        { code: 'IDB_ORPHANED_COLLECTION_FILES', collection: identity, files },
      )
    }

    return Object.freeze({
      collection: identity,
      databasePath: path.join(this.storagePath, databaseNames[0]),
      blobPath: path.join(this.storagePath, blobNames[0]),
      existing: true,
    })
  }

  /** @param {string} identity @param {CatalogReservation} reservation */
  pairFromReservation(identity, reservation) {
    return Object.freeze({
      collection: identity,
      databasePath: path.join(this.storagePath, reservation.databaseName),
      blobPath: path.join(this.storagePath, reservation.blobName),
      existing: false,
    })
  }

  /**
   * Revalidates paths remembered by the catalog without rescanning every file
   * in a potentially large storage directory. This prevents SQLite's writable
   * open modes from silently recreating one member of a pair which disappeared
   * while its collection was evicted from the connection cache.
   *
   * @param {string} identity
   * @param {CollectionFilePair} pair
   * @returns {Promise<'complete' | 'missing'>}
   */
  async inspectPair(identity, pair) {
    const filenames = [path.basename(pair.databasePath), path.basename(pair.blobPath)]

    const inspect = async (filename) => {
      try {
        return await this.inspectFile(path.join(this.storagePath, filename))
      } catch (error) {
        if (isMissingDirectory(error)) return null
        throw error
      }
    }
    const [databaseEntry, blobEntry] = await Promise.all(filenames.map(inspect))
    const present = [databaseEntry, blobEntry]
    if (!databaseEntry && !blobEntry) return 'missing'
    if (!databaseEntry || !blobEntry) {
      const existingFiles = filenames.filter((_, index) => present[index])
      const missing = databaseEntry ? 'blob' : 'collection'
      throw new StorageCatalogError(
        `Collection ${identity} has an orphaned file; its matching ${missing} database is missing`,
        {
          code: 'IDB_ORPHANED_COLLECTION_FILES',
          collection: identity,
          files: existingFiles,
        },
      )
    }

    for (let index = 0; index < present.length; index++) {
      const entry = present[index]
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new StorageCatalogError(
          `Collection storage entry must be a regular file: ${filenames[index]}`,
          {
            code: 'IDB_UNSAFE_COLLECTION_FILE',
            collection: identity,
            files: [filenames[index]],
          },
        )
      }
    }
    return 'complete'
  }

  /** @param {string} identity @param {CollectionFilePair} pair */
  missingPairError(identity, pair) {
    const files = [path.basename(pair.databasePath), path.basename(pair.blobPath)]
    return new StorageCatalogError(
      `Collection ${identity} storage files disappeared after they were cataloged`,
      { code: 'IDB_MISSING_COLLECTION_FILES', collection: identity, files },
    )
  }

  /**
   * Resolves both files for one case-insensitive collection identity.
   *
   * With `create: false`, a completely absent pair returns `null` and neither
   * the storage directory nor files are created. A writable miss reserves two
   * canonical lowercase paths; SQLite creates the files when it opens them.
   * Existing one-sided or ambiguous layouts always fail before a new filename
   * is reserved.
   *
   * @param {string} collection
   * @param {{ create?: boolean }} [options]
   * @returns {Promise<CollectionFilePair | null>}
   */
  resolvePair(collection, options = {}) {
    const identity = collectionIdentity(collection)
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return Promise.reject(new TypeError('resolvePair options must be an object'))
    }
    if (options.create !== undefined && typeof options.create !== 'boolean') {
      return Promise.reject(new TypeError('resolvePair create option must be a boolean'))
    }
    const create = options.create !== false

    return this.enqueue(async () => {
      await this.ensureLoaded()
      const existing = this.pairFromEntry(identity, this.entries.get(identity))
      if (existing) {
        if (await this.inspectPair(identity, existing) === 'missing') {
          throw this.missingPairError(identity, existing)
        }
        this.reservations.delete(identity)
        return existing
      }

      const reserved = this.reservations.get(identity)
      if (reserved) {
        const pair = this.pairFromReservation(identity, reserved)
        let state
        try {
          state = await this.inspectPair(identity, pair)
        } catch (error) {
          // Another writable engine can be between creating the main file and
          // attaching the blob file for this still-unconfirmed reservation.
          // It is safe for a second writer to join that initialization; both
          // connections serialize schema work with BEGIN IMMEDIATE. Once an
          // initializer confirms the pair, this reservation is removed and
          // every later reopen treats either missing member as corruption.
          if (
            create &&
            error instanceof StorageCatalogError &&
            error.code === 'IDB_ORPHANED_COLLECTION_FILES'
          ) {
            return pair
          }
          throw error
        }
        if (state === 'complete') return Object.freeze({ ...pair, existing: true })
        if (!create) return null
        return pair
      }
      if (!create) return null

      await this.makeDirectory(this.storagePath, { recursive: true })
      const reservation = {
        databaseName: `${databasePrefix}${identity}${databaseSuffix}`,
        blobName: `${blobPrefix}${identity}${databaseSuffix}`,
      }
      this.reservations.set(identity, reservation)
      return this.pairFromReservation(identity, reservation)
    })
  }

  /**
   * Confirms a new reservation only after SQLite has initialized both files.
   * Existing catalog entries need no full rescan; the method is therefore
   * cheap on ordinary LRU reopen paths.
   *
   * @param {string} collection
   * @param {CollectionFilePair} pair
   */
  confirmPair(collection, pair) {
    const identity = collectionIdentity(collection)
    if (!pair || typeof pair !== 'object') {
      return Promise.reject(new TypeError('confirmPair requires a collection file pair'))
    }
    return this.enqueue(async () => {
      const reservation = this.reservations.get(identity)
      if (!reservation) return
      const expected = this.pairFromReservation(identity, reservation)
      if (
        path.resolve(pair.databasePath) !== path.resolve(expected.databasePath) ||
        path.resolve(pair.blobPath) !== path.resolve(expected.blobPath)
      ) {
        throw new Error(`Collection ${identity} was initialized outside its reserved storage paths`)
      }

      await this.scan()
      const existing = this.pairFromEntry(identity, this.entries.get(identity))
      if (!existing) throw this.missingPairError(identity, expected)
      if (await this.inspectPair(identity, existing) === 'missing') {
        throw this.missingPairError(identity, existing)
      }
    })
  }

  /**
   * Lists complete pairs from the cached snapshot in collection-name order.
   * Backup callers should pass `{ refresh: true }` to obtain and validate a
   * new directory snapshot. Lowercase reservations are excluded unless
   * `includeReserved` is explicitly requested because their files may not yet
   * have been opened by SQLite.
   *
   * @param {{ refresh?: boolean, includeReserved?: boolean }} [options]
   * @returns {Promise<CollectionFilePair[]>}
   */
  listPairs(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return Promise.reject(new TypeError('listPairs options must be an object'))
    }
    if (options.refresh !== undefined && typeof options.refresh !== 'boolean') {
      return Promise.reject(new TypeError('listPairs refresh option must be a boolean'))
    }
    if (
      options.includeReserved !== undefined &&
      typeof options.includeReserved !== 'boolean'
    ) {
      return Promise.reject(new TypeError('listPairs includeReserved option must be a boolean'))
    }

    return this.enqueue(async () => {
      if (options.refresh) await this.scan()
      else await this.ensureLoaded()

      const identities = new Set(this.entries.keys())
      if (options.includeReserved) {
        for (const identity of this.reservations.keys()) identities.add(identity)
      }

      /** @type {CollectionFilePair[]} */
      const pairs = []
      for (const identity of [...identities].sort()) {
        const existing = this.pairFromEntry(identity, this.entries.get(identity))
        if (existing) {
          pairs.push(existing)
          continue
        }
        const reservation = this.reservations.get(identity)
        if (options.includeReserved && reservation) {
          pairs.push(this.pairFromReservation(identity, reservation))
        }
      }
      return pairs
    })
  }

  /**
   * Refreshes and validates the complete on-disk catalog for backup or
   * diagnostics. Reservations whose files do not yet exist are not returned.
   * @returns {Promise<CollectionFilePair[]>}
   */
  refresh() {
    return this.listPairs({ refresh: true })
  }
}

/** @param {string} storagePath */
function sharedCatalogKey(storagePath) {
  const resolved = path.resolve(storagePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Shares one live filename snapshot and reservation table among engines in
 * this process. Deterministic lowercase paths still coordinate independent
 * processes; the shared catalog additionally closes the main/blob creation
 * race between local engines.
 * @param {string} storagePath
 */
export function acquireStorageCatalog(storagePath) {
  const key = sharedCatalogKey(storagePath)
  let entry = sharedCatalogs.get(key)
  if (!entry) {
    entry = { catalog: new StorageCatalog(storagePath), references: 0 }
    sharedCatalogs.set(key, entry)
  }
  entry.references++
  return entry.catalog
}

/** @param {StorageCatalog} catalog */
export function releaseStorageCatalog(catalog) {
  if (!(catalog instanceof StorageCatalog)) {
    throw new TypeError('catalog must be a StorageCatalog')
  }
  for (const [key, entry] of sharedCatalogs) {
    if (entry.catalog !== catalog) continue
    entry.references--
    if (entry.references <= 0) sharedCatalogs.delete(key)
    return
  }
  throw new Error('StorageCatalog was already released or was not acquired')
}
