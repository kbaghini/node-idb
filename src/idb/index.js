// @ts-check

import { createRequire } from 'node:module'
import path from 'node:path'

import sqlite3 from 'sqlite3'

import {
  backupSqliteFile,
  checkSqliteIntegrity,
  createBackupFileMetadata,
  discardBackupStage,
  prepareBackupDestination,
  promoteBackupStage,
  throwIfAborted,
  writeBackupManifest,
} from './backup.js'
import { assertFieldName, deepClone, deepMerge, isPlainObject } from './codec.js'
import { CollectionStore } from './collection.js'
import { createAsyncQueue } from './async-queue.js'
import { closeDatabase, openDatabase } from './database.js'
import { normalizeFieldIndexes } from './field-indexes.js'
import {
  createOperationScope,
  throwIfAborted as throwIfOperationAborted,
  validateAbortSignal,
  validateTimeoutMs,
} from './operation.js'
import {
  compileExpression,
  compileObjectIds,
  compileSelect,
  decodeSelectRows,
  parseSql,
} from './sql.js'
import { acquireStorageCatalog, releaseStorageCatalog } from './storage.js'

const identifierPattern = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|\[[^\]]+\]|[A-Za-z0-9_-]+)`
const packageVersion = String(createRequire(import.meta.url)('../../package.json').version)
let callbackRunWarningEmitted = false

/** @param {string} value */
function cleanIdentifier(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replaceAll('``', '`')
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"')
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).replaceAll(']]', ']')
  }
  return trimmed
}

/** @param {string} character */
function isIdentifierCharacter(character) {
  return /[A-Za-z0-9_$-]/.test(character)
}

/**
 * Finds an outer SQL keyword while ignoring strings, quoted identifiers,
 * comments, and parenthesized expressions.
 * @param {string} source
 * @param {string} keyword
 */
function findOuterKeyword(source, keyword) {
  let quote = ''
  let depth = 0
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (quote === '\n') {
        if (character === '\n' || character === '\r') quote = ''
      } else if (quote === '*/') {
        if (character === '*' && source[index + 1] === '/') {
          quote = ''
          index++
        }
      } else if (character === quote) {
        if (source[index + 1] === quote) index++
        else quote = ''
      }
      continue
    }
    if (character === '-' && source[index + 1] === '-') {
      quote = '\n'
      index++
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      quote = '*/'
      index++
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character
      continue
    }
    if (character === '(') {
      depth++
      continue
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (
      depth === 0 &&
      source.slice(index, index + keyword.length).toLowerCase() === keyword &&
      !isIdentifierCharacter(source[index - 1] || '') &&
      !isIdentifierCharacter(source[index + keyword.length] || '')
    ) return index
  }
  return -1
}

/** @param {string} source */
function takeIdentifier(source) {
  const trimmed = source.trimStart()
  if (!trimmed) throw new Error('A collection name is required')
  const opener = trimmed[0]
  const closer = opener === '[' ? ']' : opener
  if (opener === '`' || opener === '"' || opener === '[') {
    for (let index = 1; index < trimmed.length; index++) {
      if (trimmed[index] !== closer) continue
      if (trimmed[index + 1] === closer) {
        index++
        continue
      }
      return { token: trimmed.slice(0, index + 1), rest: trimmed.slice(index + 1) }
    }
    throw new Error('Unterminated quoted identifier')
  }
  const match = /^[A-Za-z0-9_-]+/.exec(trimmed)
  if (!match) throw new Error('Invalid collection name')
  return { token: match[0], rest: trimmed.slice(match[0].length) }
}

/** @param {string} source */
function splitIdentifierList(source) {
  const result = []
  let start = 0
  let quote = ''
  for (let index = 0; index <= source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) index++
        else quote = ''
      }
      continue
    }
    if (character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character
    } else if (character === ',' || index === source.length) {
      const item = source.slice(start, index).trim()
      if (item) result.push(item)
      start = index + 1
    }
  }
  return result
}

/** @param {string} value @param {string} label */
function assertStorageName(value, label) {
  if (typeof value !== 'string' || !value.length) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (
    !/^(?=.{1,128}$)(?=.*[A-Za-z0-9_])[A-Za-z0-9_-]+$/.test(value) ||
    value === '.' || value === '..'
  ) {
    throw new Error(
      `${label} may contain only letters, numbers, underscores and hyphens`,
    )
  }
}

/** @param {string} statement */
function collectionAfterFrom(statement) {
  const fromIndex = findOuterKeyword(statement, 'from')
  if (fromIndex < 0) throw new Error('A collection name is required after FROM')
  return cleanIdentifier(takeIdentifier(statement.slice(fromIndex + 4)).token)
}

/** @param {string} statement @param {string} keywordPattern @param {string} label */
function collectionAfter(statement, keywordPattern, label) {
  const match = new RegExp(`^\\s*${keywordPattern}\\s+(${identifierPattern})`, 'i').exec(statement)
  if (!match) throw new Error(`A collection name is required after ${label}`)
  return cleanIdentifier(match[1])
}

/** @param {string} statement @param {string} command */
function assertDocumentSelector(statement, command) {
  if (
    findOuterKeyword(statement, 'group') >= 0 ||
    findOuterKeyword(statement, 'having') >= 0
  ) {
    throw new Error(`${command} does not support GROUP BY or HAVING; use SELECT for grouped results`)
  }
}

/** @param {unknown} value */
function resultRowsToIds(value) {
  return /** @type {Array<{object_id: number}>} */ (value).map((row) => Number(row.object_id))
}

/**
 * @param {unknown} target
 * @param {string} fieldPath
 * @param {unknown} value
 */
function setPath(target, fieldPath, value) {
  if (!target || typeof target !== 'object') throw new TypeError('Cannot set a field on a scalar document')
  const parts = fieldPath.split('.')
  for (const part of parts) assertFieldName(part)
  let cursor = /** @type {Record<string, unknown>} */ (target)
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]
    const next = cursor[part]
    if (!isPlainObject(next)) cursor[part] = {}
    cursor = /** @type {Record<string, unknown>} */ (cursor[part])
  }
  const leaf = parts[parts.length - 1]
  Object.defineProperty(cursor, leaf, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

/** @param {unknown} target @param {string} fieldPath */
function deletePath(target, fieldPath) {
  if (!target || typeof target !== 'object') return
  const parts = fieldPath.split('.')
  for (const part of parts) assertFieldName(part)
  let cursor = /** @type {Record<string, unknown>} */ (target)
  for (let index = 0; index < parts.length - 1; index++) {
    if (!cursor[parts[index]] || typeof cursor[parts[index]] !== 'object') return
    cursor = /** @type {Record<string, unknown>} */ (cursor[parts[index]])
  }
  const leaf = parts[parts.length - 1]
  delete cursor[leaf]
}

/** @param {unknown} target @param {string} fieldPath */
function getPath(target, fieldPath) {
  const parts = fieldPath.split('.')
  for (const part of parts) assertFieldName(part)
  let cursor = target
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return undefined
    cursor = /** @type {Record<string, unknown>} */ (cursor)[part]
  }
  return cursor
}

/** @param {CollectionStore} store @param {string} pattern */
function resolveDeletePaths(store, pattern) {
  const name = cleanIdentifier(pattern.trim())
  const fields = store.fields.filter((field) => field.parent_field_id !== null)
  if (name === '?') return fields.filter((field) => field.level === 1).map((field) => field.path)
  if (name === '*') return fields.map((field) => field.path)
  if (name.endsWith('.*') || name.endsWith('.?')) {
    const recursive = name.endsWith('.*')
    const base = name.slice(0, -2)
    const parent = fields.find((field) => field.path === base) ||
      fields.find((field) => field.path.toLowerCase() === base.toLowerCase())
    if (!parent) return []
    return fields.filter((field) => recursive
      ? field.path.startsWith(`${parent.path}.`)
      : field.parent_field_id === parent.id).map((field) => field.path)
  }
  const exact = fields.filter((field) => field.path === name)
  if (exact.length) return exact.map((field) => field.path)
  const insensitive = fields.filter((field) => field.path.toLowerCase() === name.toLowerCase())
  if (insensitive.length) return insensitive.map((field) => field.path)
  if (!name.includes('.')) {
    return fields
      .filter((field) => field.name.toLowerCase() === name.toLowerCase())
      .map((field) => field.path)
  }
  return []
}

/**
 * @typedef {'strict' | 'balanced'} IdbDurability
 * @typedef {'readwrite' | 'readonly'} IdbMode
 * @typedef {{
 *   storagePath: string,
 *   busyTimeoutMs?: number,
 *   durability?: IdbDurability,
 *   mode?: IdbMode,
 *   maxOpenCollections?: number,
 *   fieldIndexes?: unknown,
 * }} IdbOptions
 */

/**
 * Creates one isolated IDB engine bound to one storage directory. Relative
 * paths are resolved immediately so later working-directory changes cannot
 * redirect the database. Use the exact `:memory:` path for a non-persistent
 * engine.
 * @param {IdbOptions} options
 */
export function createIdb(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('createIdb requires an options object')
  }
  const unknownOptions = Object.keys(options).filter(
    (key) => ![
      'storagePath',
      'busyTimeoutMs',
      'durability',
      'mode',
      'maxOpenCollections',
      'fieldIndexes',
    ].includes(key),
  )
  if (unknownOptions.length) {
    throw new TypeError(`Unknown createIdb option: ${unknownOptions.join(', ')}`)
  }
  const {
    storagePath: requestedStoragePath,
    busyTimeoutMs = 10_000,
    durability = 'strict',
    mode = 'readwrite',
    maxOpenCollections = 16,
    fieldIndexes: requestedFieldIndexes = 'auto',
  } = options
  if (typeof requestedStoragePath !== 'string' || !requestedStoragePath.length) {
    throw new TypeError('storagePath must be a non-empty string')
  }
  if (requestedStoragePath.includes('\0')) {
    throw new TypeError('storagePath must not contain null bytes')
  }
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2_147_483_647) {
    throw new RangeError('busyTimeoutMs must be an integer from 0 through 2147483647')
  }
  if (durability !== 'strict' && durability !== 'balanced') {
    throw new TypeError('durability must be either "strict" or "balanced"')
  }
  if (mode !== 'readwrite' && mode !== 'readonly') {
    throw new TypeError('mode must be either "readwrite" or "readonly"')
  }
  if (!Number.isSafeInteger(maxOpenCollections) || maxOpenCollections < 1) {
    throw new RangeError('maxOpenCollections must be a positive safe integer')
  }
  const memory = requestedStoragePath === ':memory:'
  if (memory && mode === 'readonly') {
    throw new TypeError('mode "readonly" cannot be used with :memory: storage')
  }
  if (memory && options.maxOpenCollections !== undefined) {
    throw new TypeError(
      'maxOpenCollections cannot be used with :memory: because evicting a collection would erase it',
    )
  }
  if (mode === 'readonly' && options.durability !== undefined) {
    throw new TypeError('durability cannot be configured in readonly mode')
  }
  if (mode === 'readonly' && options.fieldIndexes !== undefined) {
    throw new TypeError('fieldIndexes cannot be changed in readonly mode')
  }
  const fieldIndexes = normalizeFieldIndexes(requestedFieldIndexes)
  const fieldIndexesProvided = Object.hasOwn(options, 'fieldIndexes')
  const storagePath = memory ? requestedStoragePath : path.resolve(requestedStoragePath)
  const storageCatalog = memory ? null : acquireStorageCatalog(storagePath)

  /** @type {Map<string, {
   *   identity: string,
   *   store: CollectionStore,
   *   ready: Promise<CollectionStore>,
   *   refs: number,
   *   lastUsed: number,
   * }>} */
  const stores = new Map()
  /** @type {Set<Promise<unknown>>} */
  const operations = new Set()
  /** @type {'open' | 'closing' | 'closed'} */
  let state = 'open'
  /** @type {Promise<void> | null} */
  let closePromise = null
  /** @type {Promise<unknown>} */
  let cacheQueue = Promise.resolve()
  /** @type {Promise<void>} */
  let operationBarrier = Promise.resolve()
  /** @type {Set<() => void>} */
  const cacheWaiters = new Set()
  let accessClock = 0
  let cacheEvictions = 0

  /** @template T @param {() => Promise<T>} operation */
  function track(operation) {
    if (state !== 'open') return Promise.reject(new Error('IDB engine is closed'))
    const barrier = operationBarrier
    const promise = barrier.then(operation)
    operations.add(promise)
    promise.then(
      () => operations.delete(promise),
      () => operations.delete(promise),
    )
    return promise
  }

  /** @template T @param {() => Promise<T>} operation */
  function trackExclusive(operation) {
    if (state !== 'open') return Promise.reject(new Error('IDB engine is closed'))
    const priorOperations = [...operations]
    /** @type {() => void} */
    let releaseBarrier
    operationBarrier = new Promise((resolve) => {
      releaseBarrier = resolve
    })
    const promise = (async () => {
      await Promise.allSettled(priorOperations)
      try {
        return await operation()
      } finally {
        releaseBarrier()
      }
    })()
    operations.add(promise)
    promise.then(
      () => operations.delete(promise),
      () => operations.delete(promise),
    )
    return promise
  }

  /** @template T @param {() => Promise<T> | T} operation @returns {Promise<T>} */
  function withCacheLock(operation) {
    const result = cacheQueue.then(operation, operation)
    cacheQueue = result.then(() => undefined, () => undefined)
    return result
  }

  function notifyCacheWaiters() {
    const waiters = [...cacheWaiters]
    cacheWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  /** @param {string} identity */
  async function createStoreEntry(identity) {
    let databasePath = ':memory:'
    let blobPath = ':memory:'
    let existing = false
    /** @type {{
     *   collection: string,
     *   databasePath: string,
     *   blobPath: string,
     *   existing: boolean,
     * } | null} */
    let pair = null
    if (storageCatalog) {
      pair = await storageCatalog.resolvePair(identity, { create: mode === 'readwrite' })
      if (!pair) {
        throw new Error(`Collection ${identity} does not exist in read-only storage`)
      }
      databasePath = pair.databasePath
      blobPath = pair.blobPath
      existing = pair.existing
    }
    const store = new CollectionStore({
      collection: identity,
      databasePath,
      blobPath,
      memory,
      existing,
      mode,
      busyTimeoutMs,
      durability,
      fieldIndexes,
      fieldIndexesProvided,
    })
    const ready = (async () => {
      try {
        await store.initialize()
        if (storageCatalog && pair) await storageCatalog.confirmPair(identity, pair)
        return store
      } catch (error) {
        await store.close().catch(() => {})
        throw error
      }
    })()
    const entry = {
      identity,
      store,
      ready,
      refs: 1,
      lastUsed: ++accessClock,
    }
    stores.set(identity, entry)
    entry.ready.catch(() => {
      withCacheLock(() => {
        if (stores.get(identity) === entry) stores.delete(identity)
        notifyCacheWaiters()
      }).catch(() => {})
    })
    return entry
  }

  /** @param {string} collection */
  async function acquireStore(collection, signal) {
    assertStorageName(collection, 'collection')
    const identity = collection.toLowerCase()

    while (true) {
      throwIfOperationAborted(signal)
      const decision = await withCacheLock(async () => {
        const existing = stores.get(identity)
        if (existing) {
          existing.refs++
          existing.lastUsed = ++accessClock
          return { entry: existing, wait: null }
        }

        if (!memory && stores.size >= maxOpenCollections) {
          const victim = [...stores.values()]
            .filter((entry) => entry.refs === 0)
            .sort((left, right) =>
              left.lastUsed - right.lastUsed || left.identity.localeCompare(right.identity),
            )[0]
          if (!victim) {
            const wait = new Promise((resolve) => cacheWaiters.add(() => resolve()))
            return { entry: null, wait }
          }

          stores.delete(victim.identity)
          try {
            await victim.ready
            await victim.store.close()
            cacheEvictions++
          } catch (error) {
            stores.set(victim.identity, victim)
            victim.lastUsed = ++accessClock
            throw new AggregateError(
              [error],
              `Failed to evict IDB collection ${victim.identity}`,
            )
          } finally {
            notifyCacheWaiters()
          }
        }

        return { entry: await createStoreEntry(identity), wait: null }
      })

      if (decision.wait) {
        if (!signal) {
          await decision.wait
        } else {
          /** @type {(value?: unknown) => void} */
          let aborted
          const abortWait = new Promise((resolve) => {
            aborted = resolve
            signal.addEventListener('abort', aborted, { once: true })
          })
          try {
            await Promise.race([decision.wait, abortWait])
          } finally {
            signal.removeEventListener('abort', aborted)
          }
          throwIfOperationAborted(signal)
        }
        continue
      }
      const entry = decision.entry
      if (!entry) continue
      try {
        return { entry, store: await entry.ready }
      } catch (error) {
        await releaseStore(entry)
        throw error
      }
    }
  }

  /** @param {{ refs: number, lastUsed: number }} entry */
  function releaseStore(entry) {
    return withCacheLock(() => {
      entry.refs = Math.max(0, entry.refs - 1)
      entry.lastUsed = ++accessClock
      notifyCacheWaiters()
    })
  }

  /**
   * @template T
   * @param {string} collection
   * @param {(store: CollectionStore) => Promise<T> | T} operation
   */
  async function withStore(collection, operation, signal) {
    const lease = await acquireStore(collection, signal)
    try {
      return await operation(lease.store)
    } finally {
      await releaseStore(lease.entry)
    }
  }

  /** @param {CollectionStore} store @param {any} statement @param {unknown} parameters */
  async function selectObjectIds(store, statement, parameters) {
    const compiled = compileObjectIds(store, statement, parameters)
    const startedAt = performance.now()
    const rows = await store.rawAll(compiled.sql, compiled.parameters)
    store.recordQueryObservation(compiled.usage, {
      durationMs: performance.now() - startedAt,
      resultRows: rows.length,
    })
    return resultRowsToIds(rows)
  }

  /** @param {string} statement @param {unknown} parameters */
  async function insert(statement, parameters, signal) {
    const collection = collectionAfter(statement, String.raw`insert\s+into`, 'INSERT INTO')
    const tail = statement.replace(
      new RegExp(`^\\s*insert\\s+into\\s+${identifierPattern}\\s*;?\\s*$`, 'i'),
      '',
    )
    if (tail) throw new Error('INSERT accepts a collection and document payload only')
    return withStore(collection, async (store) => {
      if (Array.isArray(parameters)) return store.writeDocuments(parameters, undefined, { signal })
      const [objectId] = await store.writeDocuments([parameters], undefined, { signal })
      return objectId
    }, signal)
  }

  /**
   * @param {string} statement
   * @param {unknown} parameters
   * @param {'update' | 'replace'} mode
   */
  async function upsert(statement, parameters, mode, signal, requireMatch = false) {
    const prefix = mode === 'replace'
      ? /^\s*replace\s+into\s+/i
      : /^\s*upsert\s+into\s+/i
    const remainder = statement.replace(prefix, '')
    const collectionMatch = new RegExp(`^(${identifierPattern})([\\s\\S]*)$`, 'i').exec(remainder.trim())
    const command = mode === 'replace' ? 'REPLACE INTO' : 'UPSERT INTO'
    if (!collectionMatch) throw new Error(`A collection is required after ${command}`)
    const collection = cleanIdentifier(collectionMatch[1])
    const filter = collectionMatch[2].trim()
    if (!/^where\b/i.test(filter)) {
      throw new Error(`${command} requires a WHERE clause; use INSERT INTO for unconditional inserts`)
    }
    assertDocumentSelector(`SELECT object_id FROM ${collectionMatch[1]} ${filter}`, command)
    const selector = await parseSql(`SELECT object_id FROM ${collectionMatch[1]} ${filter}`)
    return withStore(collection, (store) =>
      store.mutate(async () => {
        const objectIds = await selectObjectIds(store, selector, parameters)

        if (!objectIds.length) {
          if (requireMatch) return []
          const payloads = Array.isArray(parameters) ? parameters : [parameters]
          const inserted = await store.writeDocumentsInTransaction(payloads)
          return inserted.map((object_id) => ({ object_id, inserted: true }))
        }

        if (Array.isArray(parameters)) {
          throw new TypeError('A matched UPSERT or REPLACE requires one payload document, not an array')
        }

        const existing = await store.readDocuments(objectIds)
        const documents = objectIds.map((objectId) => mode === 'replace'
          ? parameters
          : deepMerge(existing.get(objectId), parameters))
        await store.writeDocumentsInTransaction(documents, objectIds)
        return objectIds.map((object_id) => ({ object_id }))
      }, { signal }),
      signal,
    )
  }

  /** @param {string} statement @param {unknown} parameters */
  async function select(statement, parameters, signal) {
    const collection = collectionAfterFrom(statement)
    return withStore(collection, (store) =>
      store.snapshot(async () => {
        const compiled = await compileSelect(store, statement, parameters)
        const startedAt = performance.now()
        const rows = await store.rawAll(compiled.sql, compiled.parameters)
        store.recordQueryObservation(compiled.usage, {
          durationMs: performance.now() - startedAt,
          resultRows: rows.length,
        })
        if (compiled.mode === 'documents') {
          const objectIds = resultRowsToIds(rows)
          const documents = await store.readDocuments(objectIds)
          return objectIds.filter((id) => documents.has(id)).map((id) => documents.get(id))
        }
        return decodeSelectRows(
          store,
          rows,
          compiled.metadata,
          compiled.hiddenIdentity,
          compiled.objectProjectionError,
        )
      }, { signal }),
      signal,
    )
  }

  /** @param {string} statement @param {unknown} parameters */
  async function findDocuments(statement, parameters, signal) {
    const normalized = statement.replace(/^\s*find\s+/i, 'SELECT * FROM ')
    assertDocumentSelector(normalized, 'FIND')
    return select(normalized, parameters, signal)
  }

  /** @param {string} statement @param {unknown} parameters */
  async function update(statement, parameters, signal) {
    const collection = collectionAfter(statement, 'update', 'UPDATE')
    assertDocumentSelector(statement, 'UPDATE')
    const hasSet = new RegExp(`^\\s*update\\s+${identifierPattern}\\s+set\\b`, 'i').test(statement)

    if (!hasSet) {
      if (Array.isArray(parameters)) {
        throw new TypeError('Payload-style UPDATE requires one payload document, not an array')
      }
      const filter = statement.replace(
        new RegExp(`^\\s*update\\s+${identifierPattern}`, 'i'),
        '',
      )
      const parsed = await parseSql(`SELECT object_id FROM ${collection} ${filter}`)
      return withStore(collection, (store) => store.mutate(async () => {
        const objectIds = await selectObjectIds(store, parsed, parameters)
        if (!objectIds.length) return []
        const existing = await store.readDocuments(objectIds)
        const documents = objectIds.map((id) => deepMerge(existing.get(id), parameters))
        await store.writeDocumentsInTransaction(documents, objectIds)
        return objectIds.map((object_id) => ({ object_id }))
      }, { signal }), signal)
    }

    const parsed = await parseSql(statement)
    if (parsed.variant !== 'update') throw new Error('Invalid UPDATE statement')
    return withStore(collection, (store) => store.mutate(async () => {
      const objectIds = await selectObjectIds(store, parsed, parameters)
      if (!objectIds.length) return []
      const existing = await store.readDocuments(objectIds)
      const documents = new Map(
        [...existing].map(([objectId, document]) => [objectId, deepClone(document)]),
      )

      // SQLite SET expressions are evaluated against the original row, matching
      // standard SQL behavior even when several assignments target one document.
      for (const assignment of parsed.set || []) {
        const targetName = cleanIdentifier(String(assignment.target.name))
        const targetPath = targetName.toLowerCase().startsWith(`${collection.toLowerCase()}.`)
          ? targetName.slice(collection.length + 1)
          : targetName
        const expression = compileExpression(store, parsed, assignment.value, parameters, objectIds)
        if (expression.direct) {
          for (const objectId of objectIds) {
            const value = expression.direct.kind === 'field'
              ? getPath(existing.get(objectId), String(expression.direct.path))
              : expression.direct.value
            setPath(documents.get(objectId), targetPath, deepClone(value))
          }
          continue
        }
        const values = await store.rawAll(expression.sql, expression.parameters)
        for (const row of values) setPath(documents.get(Number(row.object_id)), targetPath, row.value)
      }

      await store.writeDocumentsInTransaction(
        objectIds.map((id) => documents.get(id)),
        objectIds,
      )
      return objectIds.map((object_id) => ({ object_id }))
    }, { signal }), signal)
  }

  /** @param {string} statement @param {unknown} parameters */
  async function remove(statement, parameters, signal) {
    const unset = /^\s*unset\b/i.test(statement)
    const body = statement.replace(unset ? /^\s*unset\b/i : /^\s*delete\b/i, '').trimStart()
    const fromIndex = findOuterKeyword(body, 'from')
    if (fromIndex < 0) throw new Error(`Invalid ${unset ? 'UNSET' : 'DELETE'} statement`)
    const selection = body.slice(0, fromIndex).trim()
    if (!unset && selection) {
      throw new Error(
        'DELETE field syntax was removed in node-idb 0.2; use UNSET fields FROM collection, or DELETE FROM collection for complete documents',
      )
    }
    if (unset && !selection) {
      throw new Error('UNSET requires one or more fields before FROM')
    }
    if (unset && selection === '*') {
      throw new Error('UNSET * is not supported; use DELETE FROM collection to remove documents')
    }
    const collectionSource = takeIdentifier(body.slice(fromIndex + 4))
    const collectionToken = collectionSource.token
    const filter = collectionSource.rest

    const collection = cleanIdentifier(collectionToken)
    const selectedIdentifiers = splitIdentifierList(selection)
    if (
      unset &&
      selectedIdentifiers.length === 1 &&
      cleanIdentifier(selectedIdentifiers[0]).toLowerCase() === collection.toLowerCase()
    ) {
      throw new Error('UNSET expects field paths, not the collection name')
    }
    assertDocumentSelector(`SELECT object_id FROM ${collectionToken} ${filter}`, unset ? 'UNSET' : 'DELETE')
    const parsed = await parseSql(`SELECT object_id FROM ${collectionToken} ${filter}`)
    return withStore(collection, (store) => store.mutate(async () => {
      const objectIds = await selectObjectIds(store, parsed, parameters)
      if (!objectIds.length) return []
      if (!unset) {
        return store.deleteObjectsInTransaction(objectIds)
      }

      const paths = [...new Set(selectedIdentifiers
        .flatMap((item) => resolveDeletePaths(store, item)))]
      if (!paths.length) return []
      const existing = await store.readDocuments(objectIds)
      const documents = objectIds.map((id) => {
        const document = existing.get(id)
        for (const fieldPath of paths) deletePath(document, fieldPath)
        return document
      })
      await store.writeDocumentsInTransaction(documents, objectIds)
      return objectIds.map((object_id) => ({ object_id }))
    }, { signal }), signal)
  }

  /** @param {string} statement @param {unknown} parameters */
  async function rawQuery(statement, parameters, signal) {
    const match = new RegExp(
      `^\\s*query\\s+on\\s+(${identifierPattern})\\s+([\\s\\S]+)$`,
      'i',
    ).exec(statement)
    if (!match) throw new Error('Raw queries must use QUERY ON collection SELECT|EXPLAIN ...')
    const collection = cleanIdentifier(match[1])
    const sql = match[2].trim()
    if (!/^\s*(select|explain)\b/i.test(sql)) {
      throw new Error('Raw queries are read-only; only SELECT or EXPLAIN is allowed')
    }
    return withStore(collection, (store) =>
      store.snapshot(() => store.rawAll(
        sql,
        /** @type {unknown[] | Record<string, unknown>} */ (parameters || []),
      ), { signal }),
      signal,
    )
  }

  /** @param {string} statement @param {unknown} parameters */
  async function executeInternal(statement, parameters, operationOptions = {}) {
    if (typeof statement !== 'string' || !statement.trim()) {
      throw new TypeError('statement must be a non-empty string')
    }
    const normalized = statement.trimStart()
    if (
      mode === 'readonly' &&
      /^(?:replace\s+into|upsert\s+into|insert\s+into|update\b|delete\s+from|unset\b)/i
        .test(normalized)
    ) {
      throw new Error('IDB engine is read-only; mutation statements are not allowed')
    }
    const { signal, requireMatch = false } = operationOptions
    throwIfOperationAborted(signal)
    if (requireMatch && !/^(?:replace|upsert)\s+into\b/i.test(normalized)) {
      throw new TypeError('execute option requireMatch is available only for UPSERT INTO and REPLACE INTO')
    }
    if (/^replace\s+into\b/i.test(normalized)) {
      return upsert(normalized, parameters, 'replace', signal, requireMatch)
    }
    if (/^upsert\s+into\b/i.test(normalized)) {
      return upsert(normalized, parameters, 'update', signal, requireMatch)
    }
    if (/^insert\s+into\b/i.test(normalized)) return insert(normalized, parameters, signal)
    if (/^select\b/i.test(normalized)) return select(normalized, parameters, signal)
    if (/^find\b/i.test(normalized)) return findDocuments(normalized, parameters, signal)
    if (/^update\b/i.test(normalized)) return update(normalized, parameters, signal)
    if (/^delete\b/i.test(normalized)) return remove(normalized, parameters, signal)
    if (/^unset\b/i.test(normalized)) return remove(normalized, parameters, signal)
    if (/^query\s+on\b/i.test(normalized)) {
      return rawQuery(normalized, parameters, signal)
    }
    if (/^(?:get|collect)\b/i.test(normalized)) {
      throw new Error(
        `${normalized.match(/^\w+/)?.[0].toUpperCase()} was removed in node-idb 0.2; use SELECT * FROM collection for complete documents`,
      )
    }
    if (/^insert\s+or\s+update\b/i.test(normalized)) {
      throw new Error('INSERT OR UPDATE was removed in node-idb 0.2; use UPSERT INTO')
    }
    if (/^insert\s+or\s+replace\b/i.test(normalized)) {
      throw new Error('INSERT OR REPLACE was removed in node-idb 0.2; use REPLACE INTO')
    }
    if (/^insert\b/i.test(normalized)) {
      throw new Error('INSERT requires the canonical INSERT INTO collection syntax')
    }
    if (/^upsert\b/i.test(normalized)) {
      throw new Error('UPSERT requires the canonical UPSERT INTO collection syntax')
    }
    if (/^replace\b/i.test(normalized)) {
      throw new Error('REPLACE requires the canonical REPLACE INTO collection syntax')
    }
    if (/^query\b/i.test(normalized)) {
      throw new Error('Raw queries require the canonical QUERY ON collection syntax')
    }
    if (/^(?:on|in|over|with|use|using)\b/i.test(normalized)) {
      throw new Error('Bare raw-query prefixes were removed in node-idb 0.2; use QUERY ON')
    }
    throw new Error('Unsupported IDB statement')
  }

  /** @param {unknown} value */
  function looksLikeStatement(value) {
    return typeof value === 'string' &&
      /^(?:find|select|insert|upsert|replace|update|unset|delete|query|get|collect|on|in|over|with|use|using)\s+/i
        .test(value.trimStart())
  }

  function warnCallbackRun() {
    if (callbackRunWarningEmitted) return
    callbackRunWarningEmitted = true
    process.emitWarning(
      'The callback overloads of run() are deprecated; use execute() or the Promise result from run(). Callback support will remain through node-idb 0.x.',
      { type: 'DeprecationWarning', code: 'NODE_IDB_RUN_CALLBACK' },
    )
  }

  /** @param {unknown} value @param {string} label */
  function normalizeOperationOptions(value, label) {
    if (value === undefined) return {}
    if (!isPlainObject(value)) throw new TypeError(`${label} must be an options object`)
    const source = /** @type {Record<string, any>} */ (value)
    const unknown = Object.keys(source).filter((key) => !['signal', 'timeoutMs'].includes(key))
    if (unknown.length) throw new TypeError(`Unknown ${label}: ${unknown.join(', ')}`)
    validateAbortSignal(source.signal, `${label} signal`)
    validateTimeoutMs(source.timeoutMs, `${label} timeoutMs`)
    return { signal: source.signal, timeoutMs: source.timeoutMs }
  }

  /** @param {unknown} value */
  function normalizeExecuteOptions(value) {
    if (value === undefined) return { requireMatch: false }
    if (!isPlainObject(value)) throw new TypeError('execute option must be an options object')
    const source = /** @type {Record<string, any>} */ (value)
    const unknown = Object.keys(source).filter(
      (key) => !['signal', 'timeoutMs', 'requireMatch'].includes(key),
    )
    if (unknown.length) throw new TypeError(`Unknown execute option: ${unknown.join(', ')}`)
    validateAbortSignal(source.signal, 'execute option signal')
    validateTimeoutMs(source.timeoutMs, 'execute option timeoutMs')
    if (source.requireMatch !== undefined && typeof source.requireMatch !== 'boolean') {
      throw new TypeError('execute option requireMatch must be a boolean')
    }
    return {
      signal: source.signal,
      timeoutMs: source.timeoutMs,
      requireMatch: source.requireMatch === true,
    }
  }

  /**
   * Throwing API.
   * @param {string} statement
   * @param {unknown} [parameters]
   * @param {unknown} [options]
   */
  function execute(statement, parameters, options, ...extra) {
    if (
      extra.length ||
      (!looksLikeStatement(statement) && looksLikeStatement(parameters))
    ) {
      return Promise.reject(new TypeError(
        'execute() no longer accepts a project; create a separate IDB engine for each storage path',
      ))
    }
    return track(async () => {
      const operationOptions = normalizeExecuteOptions(options)
      const scope = createOperationScope(operationOptions)
      try {
        return await executeInternal(statement, parameters, {
          signal: scope.signal,
          requireMatch: operationOptions.requireMatch,
        })
      } finally {
        scope.dispose()
      }
    })
  }

  /** @param {unknown} value */
  function normalizeStreamOptions(value) {
    if (value === undefined) return { batchSize: 100 }
    if (!isPlainObject(value)) throw new TypeError('stream options must be an options object')
    const source = /** @type {Record<string, any>} */ (value)
    const unknown = Object.keys(source).filter(
      (key) => !['signal', 'timeoutMs', 'batchSize'].includes(key),
    )
    if (unknown.length) throw new TypeError(`Unknown stream option: ${unknown.join(', ')}`)
    validateAbortSignal(source.signal, 'stream signal')
    validateTimeoutMs(source.timeoutMs, 'stream timeoutMs')
    const batchSize = source.batchSize ?? 100
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError('stream batchSize must be an integer from 1 through 10000')
    }
    return { signal: source.signal, timeoutMs: source.timeoutMs, batchSize }
  }

  async function produceStream(statement, parameters, batchSize, signal, queue) {
    if (typeof statement !== 'string' || !statement.trim()) {
      throw new TypeError('statement must be a non-empty string')
    }
    const normalized = statement.trimStart()
    const find = /^find\b/i.test(normalized)
    if (!find && !/^select\b/i.test(normalized)) {
      throw new Error('stream() supports only SELECT and FIND statements')
    }
    const selection = find
      ? normalized.replace(/^\s*find\s+/i, 'SELECT * FROM ')
      : normalized
    if (find) assertDocumentSelector(selection, 'FIND')
    const collection = collectionAfterFrom(selection)

    await withStore(collection, (store) => store.snapshot(async () => {
      const compiled = await compileSelect(store, selection, parameters)
      const sourceSql = compiled.sql.replace(/;\s*$/, '')
      let offset = 0
      let resultRows = 0
      const startedAt = performance.now()
      while (true) {
        throwIfOperationAborted(signal)
        const rows = await store.rawAll(
          `SELECT * FROM (${sourceSql}) AS "__node_idb_stream" LIMIT ? OFFSET ?`,
          [...compiled.parameters, batchSize, offset],
        )
        if (!rows.length) break
        resultRows += rows.length
        if (compiled.mode === 'documents') {
          const objectIds = resultRowsToIds(rows)
          const documents = await store.readDocuments(objectIds)
          await queue.push(objectIds
            .filter((objectId) => documents.has(objectId))
            .map((objectId) => documents.get(objectId)))
        } else {
          await queue.push(await decodeSelectRows(
            store,
            rows,
            compiled.metadata,
            compiled.hiddenIdentity,
            compiled.objectProjectionError,
          ))
        }
        offset += rows.length
        if (rows.length < batchSize) break
      }
      store.recordQueryObservation(compiled.usage, {
        durationMs: performance.now() - startedAt,
        resultRows,
      })
    }, { signal }), signal)
  }

  /**
   * Returns a bounded, backpressured async iterator. Its SQLite snapshot and
   * collection lease live until iteration completes or the consumer stops.
   */
  function stream(statement, parameters, options, ...extra) {
    return (async function* () {
      if (
        extra.length ||
        (!looksLikeStatement(statement) && looksLikeStatement(parameters))
      ) {
        throw new TypeError(
          'stream() does not accept a project; create a separate IDB engine for each storage path',
        )
      }
      if (state !== 'open') throw new Error('IDB engine is closed')
      const streamOptions = normalizeStreamOptions(options)
      const scope = createOperationScope(streamOptions)
      const queue = createAsyncQueue()
      const barrier = operationBarrier
      /** @type {(value?: unknown) => void} */
      let releaseLifetime
      const lifetime = new Promise((resolve) => { releaseLifetime = resolve })
      operations.add(lifetime)
      let producer
      try {
        await barrier
        throwIfOperationAborted(scope.signal)
        producer = produceStream(
          statement,
          parameters,
          streamOptions.batchSize,
          scope.signal,
          queue,
        ).then(
          () => queue.close(),
          (error) => queue.close(error),
        )
        while (true) {
          const next = await queue.next()
          if (next.done) break
          for (const value of /** @type {unknown[]} */ (next.value)) yield value
        }
        await producer
      } finally {
        if (!scope.signal.aborted) {
          scope.abort(new Error('The stream consumer stopped before completion.'))
        }
        queue.close()
        await producer?.catch(() => {})
        scope.dispose()
        operations.delete(lifetime)
        releaseLifetime()
      }
    })()
  }

  /** @param {unknown} value @param {string} label */
  function normalizeCollectionOptions(value, label) {
    if (value === undefined) return {}
    if (!isPlainObject(value)) throw new TypeError(`${label} options must be an object`)
    const source = /** @type {Record<string, any>} */ (value)
    const unknown = Object.keys(source).filter(
      (key) => !['signal', 'timeoutMs', 'collections'].includes(key),
    )
    if (unknown.length) throw new TypeError(`Unknown ${label} option: ${unknown.join(', ')}`)
    validateAbortSignal(source.signal, `${label} signal`)
    validateTimeoutMs(source.timeoutMs, `${label} timeoutMs`)
    let collections
    if (source.collections !== undefined) {
      if (!Array.isArray(source.collections) || !source.collections.length) {
        throw new TypeError(`${label} collections must be a non-empty array when provided`)
      }
      collections = source.collections.map((collection) => {
        assertStorageName(collection, `${label} collection`)
        return collection.toLowerCase()
      })
      if (new Set(collections).size !== collections.length) {
        throw new Error(`${label} collections must not contain duplicate identities`)
      }
    }
    return { signal: source.signal, timeoutMs: source.timeoutMs, collections }
  }

  async function availableCollections(signal) {
    throwIfOperationAborted(signal)
    const names = storageCatalog
      ? (await storageCatalog.refresh()).map((pair) => pair.collection)
      : [...stores.keys()].sort()
    throwIfOperationAborted(signal)
    return names
  }

  async function selectedCollections(requested, label, signal) {
    const available = await availableCollections(signal)
    if (!requested) return available
    const known = new Set(available)
    const missing = requested.filter((collection) => !known.has(collection))
    if (missing.length) throw new Error(`${label} collections do not exist: ${missing.join(', ')}`)
    return requested
  }

  function normalizeOptimizeIndexOptions(value) {
    if (value === undefined) return { dryRun: false }
    if (!isPlainObject(value)) throw new TypeError('optimizeIndexes options must be an object')
    const source = /** @type {Record<string, any>} */ (value)
    const unknown = Object.keys(source).filter(
      (key) => !['signal', 'timeoutMs', 'collections', 'dryRun'].includes(key),
    )
    if (unknown.length) throw new TypeError(`Unknown optimizeIndexes option: ${unknown.join(', ')}`)
    const common = normalizeCollectionOptions({
      signal: source.signal,
      timeoutMs: source.timeoutMs,
      ...(source.collections === undefined ? {} : { collections: source.collections }),
    }, 'optimizeIndexes')
    if (source.dryRun !== undefined && typeof source.dryRun !== 'boolean') {
      throw new TypeError('optimizeIndexes dryRun must be a boolean')
    }
    return { ...common, dryRun: source.dryRun === true }
  }

  function optimizeIndexes(options) {
    return track(async () => {
      if (mode === 'readonly') throw new Error('IDB engine is read-only')
      const optimizeOptions = normalizeOptimizeIndexOptions(options)
      const scope = createOperationScope(optimizeOptions)
      try {
        const collections = await selectedCollections(
          optimizeOptions.collections,
          'optimizeIndexes',
          scope.signal,
        )
        const results = []
        for (const collection of collections) {
          results.push(await withStore(
            collection,
            (store) => store.optimizeIndexes({
              dryRun: optimizeOptions.dryRun,
              signal: scope.signal,
            }),
            scope.signal,
          ))
        }
        return Object.freeze(results)
      } finally {
        scope.dispose()
      }
    })
  }

  function diagnostics(options) {
    return track(async () => {
      const operationOptions = normalizeOperationOptions(options, 'diagnostics option')
      const scope = createOperationScope(operationOptions)
      try {
        const collections = await availableCollections(scope.signal)
        const openCollections = await Promise.all([...stores.values()]
          .sort((left, right) => left.identity.localeCompare(right.identity))
          .map(async (entry) => {
            const store = await entry.ready
            return Object.freeze({
              ...store.diagnostics(),
              leases: entry.refs,
              lastUsed: entry.lastUsed,
            })
          }))
        return Object.freeze({
          storagePath,
          mode,
          state,
          schemaVersion: 5,
          busyTimeoutMs,
          durability: mode === 'readwrite' ? durability : null,
          fieldIndexes: mode === 'readwrite'
            ? JSON.parse(fieldIndexes.serialized)
            : null,
          operations: Object.freeze({ active: operations.size }),
          cache: Object.freeze({
            limit: memory ? null : maxOpenCollections,
            open: stores.size,
            waiting: cacheWaiters.size,
            evictions: cacheEvictions,
          }),
          collections: Object.freeze(collections),
          openCollections: Object.freeze(openCollections),
        })
      } finally {
        scope.dispose()
      }
    })
  }

  /** @param {unknown} value */
  function normalizeStructureOptions(value) {
    if (value === undefined) return {}
    if (!isPlainObject(value)) throw new TypeError('structure options must be an object')
    const source = /** @type {Record<string, any>} */ (value)
    const unknown = Object.keys(source).filter(
      (key) => !['signal', 'timeoutMs', 'path'].includes(key),
    )
    if (unknown.length) throw new TypeError(`Unknown structure option: ${unknown.join(', ')}`)
    const common = normalizeOperationOptions({
      signal: source.signal,
      timeoutMs: source.timeoutMs,
    }, 'structure option')
    if (source.path === undefined) return common
    if (typeof source.path !== 'string' || !source.path.length) {
      throw new TypeError('structure path must be a non-empty canonical field path')
    }
    const segments = source.path.split('.')
    if (segments.length > 128 || segments.some((segment) => !segment.length)) {
      throw new Error('structure path must contain 1 through 128 non-empty dot-separated fields')
    }
    for (const segment of segments) assertFieldName(segment)
    return { ...common, path: source.path }
  }

  /**
   * Reports the observed nested shape of one existing collection, optionally
   * focused on one exact canonical field path.
   * @param {unknown} collection
   * @param {unknown} [options]
   */
  function structure(collection, options) {
    return track(async () => {
      assertStorageName(collection, 'structure collection')
      const structureOptions = normalizeStructureOptions(options)
      const scope = createOperationScope(structureOptions)
      try {
        const available = await availableCollections(scope.signal)
        const identity = String(collection).toLowerCase()
        const selected = available.find((candidate) => candidate.toLowerCase() === identity)
        if (!selected) throw new Error(`structure collection does not exist: ${collection}`)
        return await withStore(
          selected,
          (store) => store.structure({
            ...(structureOptions.path === undefined ? {} : { path: structureOptions.path }),
            signal: scope.signal,
          }),
          scope.signal,
        )
      } finally {
        scope.dispose()
      }
    })
  }

  function runMaintenance(operation, options) {
    return track(async () => {
      if (mode === 'readonly') throw new Error('IDB engine is read-only')
      const maintenanceOptions = normalizeCollectionOptions(options, operation)
      const scope = createOperationScope(maintenanceOptions)
      try {
        const collections = await selectedCollections(
          maintenanceOptions.collections,
          operation,
          scope.signal,
        )
        const results = []
        for (const collection of collections) {
          results.push(await withStore(
            collection,
            (store) => store.maintenance(operation, { signal: scope.signal }),
            scope.signal,
          ))
        }
        return Object.freeze(results)
      } finally {
        scope.dispose()
      }
    })
  }

  function analyze(options) {
    return runMaintenance('analyze', options)
  }

  function vacuum(options) {
    return runMaintenance('vacuum', options)
  }

  function storageStats(options) {
    return track(async () => {
      const statsOptions = normalizeCollectionOptions(options, 'storageStats')
      const scope = createOperationScope(statsOptions)
      try {
        const collections = await selectedCollections(
          statsOptions.collections,
          'storageStats',
          scope.signal,
        )
        const entries = []
        for (const collection of collections) {
          entries.push(await withStore(
            collection,
            (store) => store.storageStats({ signal: scope.signal }),
            scope.signal,
          ))
        }
        const fileBytes = entries.reduce(
          (total, entry) => total + Number(entry.files.collection || 0) + Number(entry.files.blobs || 0),
          0,
        )
        const reclaimableBytes = entries.reduce(
          (total, entry) => total + entry.main.reclaimableBytes + entry.blobs.reclaimableBytes,
          0,
        )
        return Object.freeze({
          storagePath,
          fileBytes: memory ? null : fileBytes,
          reclaimableBytes,
          collections: Object.freeze(entries),
        })
      } finally {
        scope.dispose()
      }
    })
  }

  /**
   * Compatibility API. It always resolves an envelope and also supports both
   * legacy Node-style callback overloads.
   * @param {string} statement
   * @param {unknown | ((error: unknown, result?: unknown) => void)} [parameters]
   * @param {(error: unknown, result?: unknown) => void} [callback]
   */
  function run(statement, parameters, callback, ...extra) {
    if (
      extra.length ||
      (!looksLikeStatement(statement) && looksLikeStatement(parameters))
    ) {
      const error = new TypeError(
        'run() no longer accepts a project; create a separate IDB engine for each storage path',
      )
      const legacyCallback = extra.find((value) => typeof value === 'function') ||
        (typeof callback === 'function' ? callback : undefined)
      const promise = Promise.resolve({ error, result: undefined })
      if (legacyCallback) {
        warnCallbackRun()
        promise.then(({ error: cause }) => legacyCallback(cause))
      }
      return promise
    }
    if (typeof parameters === 'function') {
      callback = /** @type {(error: unknown, result?: unknown) => void} */ (parameters)
      parameters = undefined
    }
    if (callback !== undefined && typeof callback !== 'function') {
      const error = new TypeError('callback must be a function')
      return Promise.resolve({ error, result: undefined })
    }
    if (callback) warnCallbackRun()
    const promise = track(() => executeInternal(statement, parameters)).then(
      (result) => ({ error: null, result }),
      (error) => ({ error, result: undefined }),
    )
    if (callback) {
      promise.then(({ error, result }) => callback?.(error, result))
    }
    return promise
  }

  /**
   * @param {import('sqlite3').Database} source
   * @param {string} destinationPath
   * @param {{ signal?: AbortSignal }} options
   */
  async function copyBackupFile(source, destinationPath, options) {
    await backupSqliteFile(source, destinationPath, {
      busyTimeoutMs,
      signal: options.signal,
    })
  }

  /** @param {string} filename */
  function openBackupSource(filename) {
    return openDatabase(
      filename,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_URI | sqlite3.OPEN_FULLMUTEX,
    )
  }

  /**
   * Creates a verified per-collection backup in a staged directory, then
   * publishes it atomically at the requested destination.
   * @param {unknown} backupOptions
   */
  async function performBackup(backupOptions) {
    if (!isPlainObject(backupOptions)) {
      throw new TypeError('backup() requires an options object')
    }
    const source = /** @type {Record<string, any>} */ (backupOptions)
    const unknown = Object.keys(backupOptions).filter(
      (key) => !['destinationPath', 'overwrite', 'integrityCheck', 'signal', 'collections'].includes(key),
    )
    if (unknown.length) throw new TypeError(`Unknown backup option: ${unknown.join(', ')}`)
    const {
      destinationPath,
      overwrite = false,
      integrityCheck = 'quick',
      signal,
      collections,
    } = source
    if (typeof destinationPath !== 'string' || !destinationPath.length) {
      throw new TypeError('backup destinationPath must be a non-empty string')
    }
    if (destinationPath.includes('\0')) {
      throw new TypeError('backup destinationPath must not contain null bytes')
    }
    if (typeof overwrite !== 'boolean') throw new TypeError('backup overwrite must be a boolean')
    if (integrityCheck !== 'quick' && integrityCheck !== 'full') {
      throw new TypeError('backup integrityCheck must be either "quick" or "full"')
    }
    if (
      signal !== undefined &&
      (
        !signal ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function'
      )
    ) {
      throw new TypeError('backup signal must be an AbortSignal')
    }
    if (memory || !storageCatalog) {
      throw new Error('backup() currently requires a filesystem storagePath')
    }
    throwIfAborted(signal)

    /** @type {string[] | null} */
    let selected = null
    if (collections !== undefined) {
      if (!Array.isArray(collections) || !collections.length) {
        throw new TypeError('backup collections must be a non-empty array when provided')
      }
      selected = collections.map((collection) => {
        assertStorageName(collection, 'backup collection')
        return collection.toLowerCase()
      })
      if (new Set(selected).size !== selected.length) {
        throw new Error('backup collections must not contain duplicate identities')
      }
    }

    const stage = await prepareBackupDestination({
      sourcePath: storagePath,
      destinationPath,
      overwrite,
      signal,
    })
    try {
      throwIfAborted(signal)
      const availablePairs = await storageCatalog.refresh()
      if (!availablePairs.length) {
        throw new Error('No collection databases exist to back up')
      }
      const pairsByCollection = new Map(
        availablePairs.map((pair) => [pair.collection, pair]),
      )
      const requestedCollections = selected || availablePairs.map((pair) => pair.collection)
      const missing = requestedCollections.filter((collection) => !pairsByCollection.has(collection))
      if (missing.length) {
        throw new Error(`Backup collections do not exist: ${missing.join(', ')}`)
      }

      /** @type {Array<{
       *   collection: string,
       *   kind: 'collection' | 'blobs',
       *   filename: string,
       *   bytes: number,
       *   sha256: string,
       * }>} */
      const files = []
      for (const collection of requestedCollections) {
        const pair = pairsByCollection.get(collection)
        if (!pair) continue
        const mainFilename = `db-collection-${collection}.sqlite`
        const blobFilename = `db-blobs-${collection}.sqlite`
        const mainDestination = path.join(stage.stagingPath, mainFilename)
        const blobDestination = path.join(stage.stagingPath, blobFilename)

        await withStore(collection, (store) => store.snapshot(async () => {
          // Touch both schemas inside one attached read transaction. In DELETE
          // journal mode this holds a mutually consistent main/blob snapshot
          // while the ordinary one-file SQLite backup API copies each file.
          await store.rawAll(
            `SELECT
               (SELECT COUNT(*) FROM main.sqlite_master) AS main_schema_rows,
               (SELECT COUNT(*) FROM blobs.sqlite_master) AS blob_schema_rows`,
          )
          const mainSource = await openBackupSource(pair.databasePath)
          try {
            await copyBackupFile(mainSource, mainDestination, { signal })
          } finally {
            await closeDatabase(mainSource)
          }
          const blobSource = await openBackupSource(pair.blobPath)
          try {
            await copyBackupFile(blobSource, blobDestination, { signal })
          } finally {
            await closeDatabase(blobSource)
          }
        }))

        await checkSqliteIntegrity(mainDestination, { mode: integrityCheck, signal })
        await checkSqliteIntegrity(blobDestination, { mode: integrityCheck, signal })
        files.push(await createBackupFileMetadata(mainDestination, {
          collection,
          kind: 'collection',
          signal,
        }))
        files.push(await createBackupFileMetadata(blobDestination, {
          collection,
          kind: 'blobs',
          signal,
        }))
      }

      throwIfAborted(signal)
      const createdAt = new Date().toISOString()
      const manifest = await writeBackupManifest(stage.stagingPath, {
        nodeIdbVersion: packageVersion,
        collections: requestedCollections,
        files,
        createdAt,
        sqliteVersion: sqlite3.VERSION,
      })
      // promoteBackupStage performs its own final check after it verifies the
      // staged files and any existing recognized destination.
      throwIfAborted(signal)
      await promoteBackupStage(stage, { signal })
      return Object.freeze({
        destinationPath: stage.destinationPath,
        createdAt: manifest.createdAt,
        collections: Object.freeze([...manifest.collections]),
        files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
      })
    } catch (error) {
      try {
        await discardBackupStage(stage)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Backup failed and its private staging directory could not be removed: ${stage.stagingPath}`,
        )
      }
      throw error
    }
  }

  /** @param {unknown} options */
  function backup(options) {
    return trackExclusive(() => performBackup(options))
  }

  function close(...arguments_) {
    if (arguments_.length) {
      return Promise.reject(new TypeError('close() no longer accepts a project; each engine owns one storage path'))
    }
    if (closePromise) return closePromise
    state = 'closing'
    closePromise = (async () => {
      try {
        while (operations.size) await Promise.allSettled([...operations])
        const entries = await withCacheLock(() => {
          const matches = [...stores.values()]
          stores.clear()
          notifyCacheWaiters()
          return matches
        })
        const results = await Promise.allSettled(entries.map(async (entry) => {
          const store = await entry.ready.catch(() => null)
          if (store) await store.close()
        }))
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => /** @type {PromiseRejectedResult} */ (result).reason)
        if (errors.length) throw new AggregateError(errors, 'Failed to close one or more IDB collections')
      } finally {
        try {
          if (storageCatalog) releaseStorageCatalog(storageCatalog)
        } finally {
          state = 'closed'
        }
      }
    })()
    return closePromise
  }

  return Object.freeze({
    run,
    execute,
    stream,
    backup,
    structure,
    diagnostics,
    analyze,
    vacuum,
    storageStats,
    optimizeIndexes,
    close,
  })
}
