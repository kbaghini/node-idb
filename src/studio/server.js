// @ts-check

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { createIdb } from '../idb/index.js'
import { inspectStorage } from '../idb/inspect.js'
import { parseSql } from '../idb/sql.js'
import { decodeStudioValue, encodeStudioValue } from './codec.js'

const host = '127.0.0.1'
const collectionPattern = /^(?=.{1,128}$)(?=.*[A-Za-z0-9_])[A-Za-z0-9_-]+$/
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url))
const staticAssets = Object.freeze({
  '/': Object.freeze({ file: 'index.html', type: 'text/html; charset=utf-8' }),
  '/index.html': Object.freeze({ file: 'index.html', type: 'text/html; charset=utf-8' }),
  '/studio.css': Object.freeze({ file: 'studio.css', type: 'text/css; charset=utf-8' }),
  '/studio.js': Object.freeze({ file: 'studio.js', type: 'text/javascript; charset=utf-8' }),
})

/**
 * @typedef {{
 *   rootPath: string,
 *   port?: number,
 *   writable?: boolean,
 *   maxRows?: number,
 *   bodyLimitBytes?: number,
 *   queryTimeoutMs?: number,
 * }} StudioOptions
 * @typedef {{
 *   id: string,
 *   name: string,
 *   location: 'root' | 'child',
 *   storagePath: string,
 *   realPath: string,
 *   directoryFingerprint: string,
 *   fingerprint: string,
 *   inspection: Awaited<ReturnType<typeof inspectStorage>>,
 * }} DatabaseEntry
 */

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} label */
function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`Unknown ${label}: ${unknown.join(', ')}`)
}

/** @param {unknown} value @param {string} label */
function requestObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a JSON object`)
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value @param {string} label */
function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (value.includes('\0')) throw new TypeError(`${label} must not contain null bytes`)
  return value
}

/** @param {unknown} value @param {string} label @param {number} maximum */
function boundedPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`)
  }
  return Number(value)
}

/** @param {unknown} value @param {string} label */
function objectId(value, label = 'objectId') {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return Number(value)
}

/** @param {unknown} value */
function normalizeOptions(value) {
  if (!isPlainObject(value)) throw new TypeError('startStudio requires an options object')
  const options = /** @type {Record<string, any>} */ (value)
  assertKnownKeys(
    options,
    ['rootPath', 'port', 'writable', 'maxRows', 'bodyLimitBytes', 'queryTimeoutMs'],
    'startStudio option',
  )
  const rootPath = nonEmptyString(options.rootPath, 'rootPath')
  const port = options.port ?? 4177
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('port must be an integer from 0 through 65535')
  }
  if (options.writable !== undefined && typeof options.writable !== 'boolean') {
    throw new TypeError('writable must be a boolean')
  }
  const maxRows = boundedPositiveInteger(options.maxRows ?? 500, 'maxRows', 10_000)
  const bodyLimitBytes = boundedPositiveInteger(
    options.bodyLimitBytes ?? 2 * 1024 * 1024,
    'bodyLimitBytes',
    64 * 1024 * 1024,
  )
  const queryTimeoutMs = boundedPositiveInteger(
    options.queryTimeoutMs ?? 10_000,
    'queryTimeoutMs',
    600_000,
  )
  return Object.freeze({
    rootPath: path.resolve(rootPath),
    port: Number(port),
    writable: options.writable === true,
    maxRows,
    bodyLimitBytes,
    queryTimeoutMs,
  })
}

/** @param {string} parent @param {string} candidate */
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** @param {import('node:fs').Stats} info */
function fileIdentity(info) {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}:${info.mode}`
}

/** @param {string} collection */
function quoteIdentifier(collection) {
  return `\`${collection.replaceAll('`', '``')}\``
}

/**
 * Rejects additional SQL statements without mistaking semicolons inside
 * strings, quoted identifiers, or comments for a terminator.
 * @param {string} statement
 */
function assertSingleSelect(statement) {
  if (!/^\s*select\b/i.test(statement)) {
    throw new HttpError(400, 'select_only', 'Studio query console accepts canonical SELECT statements only')
  }
  let quote = ''
  let lineComment = false
  let blockComment = false
  let terminated = false
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index]
    const next = statement[index + 1]
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      const closes = quote === ']' ? character === ']' : character === quote
      if (closes) {
        if (quote !== ']' && next === character) index++
        else quote = ''
      }
      continue
    }
    if (character === '-' && next === '-') {
      lineComment = true
      index++
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character
      continue
    }
    if (character === ';') {
      if (terminated) {
        throw new HttpError(400, 'select_only', 'Studio query console accepts exactly one SELECT statement')
      }
      terminated = true
      continue
    }
    if (terminated && !/\s/.test(character)) {
      throw new HttpError(400, 'select_only', 'Studio query console accepts exactly one SELECT statement')
    }
  }
  if (blockComment || quote) {
    throw new HttpError(400, 'select_only', 'SELECT contains an unterminated quote or comment')
  }
}

/**
 * @template T, TResult
 * @param {readonly T[]} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<TResult>} operation
 * @returns {Promise<PromiseSettledResult<TResult>[]>}
 */
async function mapSettledBounded(values, concurrency, operation) {
  /** @type {PromiseSettledResult<TResult>[]} */
  const results = new Array(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      try {
        results[index] = { status: 'fulfilled', value: await operation(values[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ))
  return results
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** @param {string} value @param {string} label */
function decodePathSegment(value, label) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'invalid_path', `${label} is not valid URL encoding`)
  }
}

/**
 * Starts a private, loopback-only node-idb Studio server.
 * @param {StudioOptions} options
 */
export async function startStudioServer(options) {
  const configuration = normalizeOptions(options)
  const maxResponseBytes = Math.min(
    128 * 1024 * 1024,
    Math.max(32 * 1024 * 1024, configuration.bodyLimitBytes * 4),
  )
  if (configuration.writable) await mkdir(configuration.rootPath, { recursive: true })

  let rootInfo
  try {
    rootInfo = await lstat(configuration.rootPath)
  } catch (error) {
    throw new Error(
      `Studio rootPath is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
    throw new TypeError('Studio rootPath must be a directory')
  }
  const rootRealPath = await realpath(configuration.rootPath)
  const rootRealInfo = await lstat(rootRealPath)
  if (!rootRealInfo.isDirectory()) throw new TypeError('Studio rootPath must resolve to a directory')

  const tokenBytes = randomBytes(32)
  const token = tokenBytes.toString('base64url')
  const tokenTextBytes = Buffer.from(token)
  const idKey = randomBytes(32)
  /** @type {Map<string, DatabaseEntry>} */
  let databases = new Map()
  /** @type {readonly {name: string, message: string}[]} */
  let discoveryErrors = Object.freeze([])
  let scannedAt = new Date(0).toISOString()
  let catalogVersion = 0
  /** @type {Map<string, {engine: ReturnType<typeof createIdb>, fingerprint: string}>} */
  const engines = new Map()
  /** @type {Map<string, {promise: Promise<ReturnType<typeof createIdb>>, fingerprint: string}>} */
  const openingEngines = new Map()
  /** @type {Promise<unknown> | null} */
  let refreshInFlight = null
  /** @type {Promise<unknown> | null} */
  let refreshFollowUp = null
  let boundPort = 0
  let closing = false
  let closed = false
  /** @type {Promise<void> | null} */
  let closePromise = null

  /** @param {string} message */
  function sanitizeMessage(message) {
    let sanitized = message
    for (const sensitivePath of new Set([configuration.rootPath, rootRealPath])) {
      sanitized = sanitized.replace(
        new RegExp(escapeRegExp(sensitivePath), process.platform === 'win32' ? 'gi' : 'g'),
        '<studio-root>',
      )
    }
    return sanitized.slice(0, 1_000)
  }

  /** @param {string} realStoragePath */
  function databaseId(realStoragePath) {
    return createHmac('sha256', idKey).update(realStoragePath).digest('base64url')
  }

  /**
   * @param {string} realStoragePath
   * @param {Awaited<ReturnType<typeof inspectStorage>>} inspection
   * @param {AbortSignal} [signal]
   */
  async function storageFingerprint(realStoragePath, inspection, signal) {
    if (signal?.aborted) throw signal.reason
    const directoryInfo = await lstat(realStoragePath)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('Database path is not a physical directory')
    }
    const directoryFingerprint = fileIdentity(directoryInfo)
    const identities = [`directory:${directoryFingerprint}`]
    for (const collection of inspection.collections) {
      if (signal?.aborted) throw signal.reason
      for (const [kind, file] of Object.entries(collection.files)) {
        const info = await lstat(file.path)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Collection ${collection.collection} has an unsafe ${kind} file`)
        }
        identities.push(`${collection.collection}:${kind}:${fileIdentity(info)}`)
      }
    }
    return {
      directoryFingerprint,
      fingerprint: identities.join('|'),
    }
  }

  /** @param {string} storagePath @param {'root' | 'child'} location @param {string} name */
  async function inspectCandidate(storagePath, location, name) {
    const fileInfo = await lstat(storagePath)
    if (location === 'child' && fileInfo.isSymbolicLink()) return null
    if (!fileInfo.isDirectory()) return null
    const candidateRealPath = await realpath(storagePath)
    if (!isWithin(rootRealPath, candidateRealPath)) return null
    const inspection = await inspectStorage({
      storagePath: candidateRealPath,
      integrityCheck: 'none',
    })
    if (!inspection.collections.length) return null
    const { directoryFingerprint, fingerprint } = await storageFingerprint(
      candidateRealPath,
      inspection,
    )
    return Object.freeze({
      id: databaseId(candidateRealPath),
      name,
      location,
      storagePath,
      realPath: candidateRealPath,
      directoryFingerprint,
      fingerprint,
      inspection,
    })
  }

  async function discover() {
    if (closing) throw new Error('Studio is closing')
    const directoryEntries = await readdir(rootRealPath, { withFileTypes: true })
    const candidates = [
      Object.freeze({
        storagePath: rootRealPath,
        location: /** @type {'root'} */ ('root'),
        name: path.basename(rootRealPath) || 'database-root',
      }),
      ...directoryEntries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => Object.freeze({
          storagePath: path.join(rootRealPath, entry.name),
          location: /** @type {'child'} */ ('child'),
          name: entry.name,
        })),
    ]
    const settled = await mapSettledBounded(candidates, 8, (candidate) =>
      inspectCandidate(candidate.storagePath, candidate.location, candidate.name))
    /** @type {Map<string, DatabaseEntry>} */
    const next = new Map()
    /** @type {{name: string, message: string}[]} */
    const errors = []
    settled.forEach((result, index) => {
      const candidate = candidates[index]
      if (result.status === 'rejected') {
        errors.push({
          name: candidate.name,
          message: sanitizeMessage(
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          ),
        })
        return
      }
      if (result.value) next.set(result.value.id, result.value)
    })

    databases = next
    discoveryErrors = Object.freeze(errors.map((entry) => Object.freeze(entry)))
    scannedAt = new Date().toISOString()
    catalogVersion += 1

    await Promise.allSettled([...openingEngines]
      .filter(([id, opening]) => next.get(id)?.fingerprint !== opening.fingerprint)
      .map(([, opening]) => opening.promise))
    const staleIds = [...engines]
      .filter(([id, cached]) => next.get(id)?.fingerprint !== cached.fingerprint)
      .map(([id]) => id)
    await Promise.all(staleIds.map(async (id) => {
      const cached = engines.get(id)
      if (!cached || next.get(id)?.fingerprint === cached.fingerprint) return
      engines.delete(id)
      await cached.engine.close().catch(() => {})
    }))
    return publicState()
  }

  function refreshCatalog() {
    if (closing) return Promise.reject(new Error('Studio is closing'))
    if (!refreshInFlight) {
      const operation = discover()
      refreshInFlight = operation
      void operation.finally(() => {
        if (refreshInFlight === operation) refreshInFlight = null
      }).catch(() => {})
      return operation
    }
    if (refreshFollowUp) return refreshFollowUp
    const current = refreshInFlight
    const followUp = current.catch(() => undefined).then(() => {
      if (refreshFollowUp === followUp) refreshFollowUp = null
      return refreshCatalog()
    })
    refreshFollowUp = followUp
    void followUp.finally(() => {
      if (refreshFollowUp === followUp) refreshFollowUp = null
    }).catch(() => {})
    return followUp
  }

  function publicState() {
    return Object.freeze({
      writable: configuration.writable,
      rootPath: rootRealPath,
      scannedAt,
      catalogVersion,
      discovery: 'root-and-immediate-children',
      limits: Object.freeze({
        maxRows: configuration.maxRows,
        bodyLimitBytes: configuration.bodyLimitBytes,
        maxResponseBytes,
        queryTimeoutMs: configuration.queryTimeoutMs,
      }),
      databases: Object.freeze([...databases.values()].map((entry) => Object.freeze({
        id: entry.id,
        name: entry.name,
        location: entry.location,
        totalBytes: entry.inspection.totalBytes,
        collectionCount: entry.inspection.collections.length,
        collections: Object.freeze(entry.inspection.collections.map((collection) => Object.freeze({
          name: collection.collection,
          schemaVersion: collection.schemaVersion,
          totalBytes: collection.files.collection.bytes + collection.files.blobs.bytes,
          fieldIndexes: collection.fieldIndexes,
        }))),
      }))),
      errors: discoveryErrors,
    })
  }

  /** @param {unknown} value */
  function findDatabase(value) {
    if (typeof value !== 'string' || !value.length) {
      throw new TypeError('databaseId must be a non-empty string')
    }
    const entry = databases.get(value)
    if (!entry) throw new HttpError(404, 'database_not_found', 'Database is not in the current Studio catalog')
    return entry
  }

  /** @param {DatabaseEntry} entry @param {AbortSignal} [signal] */
  async function validateDatabasePath(entry, signal) {
    let currentRealPath
    let currentFingerprint
    try {
      const info = await lstat(entry.storagePath)
      if (entry.location === 'child' && info.isSymbolicLink()) {
        throw new Error('Database directory became a symbolic link')
      }
      currentRealPath = await realpath(entry.storagePath)
      currentFingerprint = await storageFingerprint(currentRealPath, entry.inspection, signal)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new HttpError(
        409,
        'database_stale',
        sanitizeMessage(error instanceof Error ? error.message : String(error)),
      )
    }
    if (
      currentRealPath !== entry.realPath ||
      !isWithin(rootRealPath, currentRealPath) ||
      currentFingerprint.directoryFingerprint !== entry.directoryFingerprint ||
      currentFingerprint.fingerprint !== entry.fingerprint
    ) {
      throw new HttpError(409, 'database_stale', 'Database directory changed; refresh Studio')
    }
  }

  /** @param {DatabaseEntry} entry @param {AbortSignal} signal */
  async function engineFor(entry, signal) {
    if (closing) throw new HttpError(503, 'studio_closing', 'Studio is closing')
    await validateDatabasePath(entry, signal)
    const cached = engines.get(entry.id)
    if (cached?.fingerprint === entry.fingerprint) return cached.engine
    if (cached) {
      engines.delete(entry.id)
      await cached.engine.close().catch(() => {})
    }
    const opening = openingEngines.get(entry.id)
    if (opening?.fingerprint === entry.fingerprint) return opening.promise
    if (opening) {
      await opening.promise.catch(() => {})
      const obsolete = engines.get(entry.id)
      if (obsolete?.fingerprint === opening.fingerprint) {
        engines.delete(entry.id)
        await obsolete.engine.close().catch(() => {})
      }
      if (openingEngines.get(entry.id) === opening) openingEngines.delete(entry.id)
      return engineFor(entry, signal)
    }
    const promise = (async () => {
      if (closing) throw new HttpError(503, 'studio_closing', 'Studio is closing')
      const engine = createIdb(/** @type {any} */ ({
        storagePath: entry.realPath,
        mode: configuration.writable ? 'readwrite' : 'readonly',
      }))
      const current = databases.get(entry.id)
      if (!current || current.fingerprint !== entry.fingerprint) {
        await engine.close().catch(() => {})
        throw new HttpError(409, 'database_stale', 'Database changed while it was being opened')
      }
      engines.set(entry.id, { engine, fingerprint: entry.fingerprint })
      return engine
    })()
    const openingRecord = { promise, fingerprint: entry.fingerprint }
    openingEngines.set(entry.id, openingRecord)
    void promise.finally(() => {
      if (openingEngines.get(entry.id) === openingRecord) openingEngines.delete(entry.id)
    }).catch(() => {})
    return promise
  }

  /** @param {DatabaseEntry} entry @param {unknown} requested */
  function knownCollection(entry, requested) {
    if (typeof requested !== 'string' || !collectionPattern.test(requested)) {
      throw new TypeError('collection must be a valid collection name')
    }
    const collection = entry.inspection.collections.find(
      (candidate) => candidate.collection.toLowerCase() === requested.toLowerCase(),
    )?.collection
    if (!collection) {
      throw new HttpError(404, 'collection_not_found', 'Collection is not in this database')
    }
    return collection
  }

  /** @param {DatabaseEntry} entry @param {string} statement */
  async function knownSelectCollection(entry, statement) {
    let parsed
    try {
      parsed = await parseSql(statement)
    } catch (error) {
      throw new HttpError(
        400,
        'invalid_select',
        sanitizeMessage(error instanceof Error ? error.message : String(error)),
      )
    }
    if (
      parsed?.variant !== 'select' ||
      parsed.from?.type !== 'identifier' ||
      parsed.from?.variant !== 'table' ||
      typeof parsed.from.name !== 'string'
    ) {
      throw new HttpError(
        400,
        'invalid_select_source',
        'Studio SELECT requires exactly one existing collection in FROM',
      )
    }
    return knownCollection(entry, parsed.from.name)
  }

  function requireWritable() {
    if (!configuration.writable) {
      throw new HttpError(
        403,
        'studio_read_only',
        'Studio is read-only; restart it with writable: true to enable mutations',
      )
    }
  }

  /** @param {unknown} value @param {string} label */
  function decodeWire(value, label) {
    try {
      return decodeStudioValue(value, {
        maxStringBytes: configuration.bodyLimitBytes,
        maxBinaryBytes: configuration.bodyLimitBytes,
      })
    } catch (error) {
      throw new HttpError(
        400,
        'invalid_wire_value',
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** @param {unknown} value */
  function encodeResponseValue(value) {
    try {
      return encodeStudioValue(value)
    } catch (error) {
      throw new HttpError(
        413,
        'response_too_large',
        `Studio result exceeds its typed transport limits: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** @param {number} used @param {unknown} value */
  function addToResponseBudget(used, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + (used ? 1 : 0)
    if (used + bytes > maxResponseBytes - 8 * 1024) {
      throw new HttpError(
        413,
        'response_too_large',
        `Studio result exceeds the ${maxResponseBytes}-byte response limit`,
      )
    }
    return used + bytes
  }

  /** @param {unknown} error @param {string} code */
  function operationError(error, code) {
    if (error instanceof HttpError) return error
    return new HttpError(
      422,
      code,
      sanitizeMessage(error instanceof Error ? error.message : String(error)),
    )
  }

  /** @param {import('node:http').IncomingMessage} request @param {AbortSignal} signal */
  async function readJson(request, signal) {
    if (signal.aborted) throw signal.reason
    const declaredLength = request.headers['content-length']
    if (declaredLength !== undefined) {
      const parsedLength = Number(declaredLength)
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        throw new HttpError(400, 'invalid_content_length', 'Invalid Content-Length header')
      }
      if (parsedLength > configuration.bodyLimitBytes) {
        request.resume()
        throw new HttpError(413, 'body_too_large', 'Request body exceeds the Studio limit')
      }
    }
    const contentType = request.headers['content-type']
    /** @type {Buffer[]} */
    const chunks = []
    let bytes = 0
    let tooLarge = false
    for await (const chunk of request) {
      if (signal.aborted) throw signal.reason
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > configuration.bodyLimitBytes) {
        tooLarge = true
      } else {
        chunks.push(buffer)
      }
    }
    if (signal.aborted) throw signal.reason
    if (tooLarge) throw new HttpError(413, 'body_too_large', 'Request body exceeds the Studio limit')
    if (!bytes) return {}
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new HttpError(415, 'unsupported_media_type', 'Studio API bodies must use application/json')
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON')
    }
  }

  /** @param {import('node:http').IncomingMessage} request */
  function authenticated(request) {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
    const candidate = Buffer.from(authorization.slice(7))
    return candidate.length === tokenTextBytes.length && timingSafeEqual(candidate, tokenTextBytes)
  }

  /** @param {import('node:http').IncomingMessage} request */
  function validHost(request) {
    if (typeof request.headers.host !== 'string') return false
    const actual = request.headers.host.toLowerCase()
    const expected = new Set([
      `${host}:${boundPort}`,
      `localhost:${boundPort}`,
      ...(boundPort === 80 ? [host, 'localhost'] : []),
    ])
    return expected.has(actual)
  }

  /** @param {import('node:http').IncomingMessage} request */
  function validOrigin(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = request.headers.origin
    if (origin === undefined) return true
    if (typeof origin !== 'string') return false
    try {
      const parsed = new URL(origin)
      const originPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : -1
      return parsed.protocol === 'http:' &&
        (parsed.hostname === host || parsed.hostname === 'localhost') &&
        originPort === boundPort &&
        parsed.username === '' &&
        parsed.password === ''
    } catch {
      return false
    }
  }

  /** @param {import('node:http').ServerResponse} response @param {'api' | 'static'} kind */
  function secureHeaders(response, kind) {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    )
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Cache-Control', 'no-store')
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {unknown} payload
   * @param {boolean} [head]
   */
  function sendJson(response, status, payload, head = false) {
    const serialized = JSON.stringify(payload)
    const bytes = Buffer.byteLength(serialized)
    if (status < 400 && bytes > maxResponseBytes) {
      throw new HttpError(
        413,
        'response_too_large',
        `Studio response exceeds the ${maxResponseBytes}-byte response limit`,
      )
    }
    const body = Buffer.from(serialized)
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Length', body.length)
    response.end(head ? undefined : body)
  }

  /**
   * @param {DatabaseEntry} entry
   * @param {string} collection
   * @param {AbortSignal} signal
   * @param {boolean} [includeStatistics]
   */
  async function collectionSchema(entry, collection, signal, includeStatistics = true) {
    const engine = await engineFor(entry, signal)
    const quoted = quoteIdentifier(collection)
    try {
      const [fields, totals, diagnostics, structure] = await Promise.all([
        engine.execute(
          `QUERY ON ${quoted} SELECT id, name, level, parent_field_id FROM tbl_fields ORDER BY level, id`,
          undefined,
          { signal, timeoutMs: configuration.queryTimeoutMs },
        ),
        engine.execute(
          `SELECT COUNT(*) AS count FROM ${quoted}`,
          undefined,
          { signal, timeoutMs: configuration.queryTimeoutMs },
        ),
        engine.diagnostics({ signal, timeoutMs: configuration.queryTimeoutMs }),
        includeStatistics
          ? engine.structure(collection, { signal, timeoutMs: configuration.queryTimeoutMs })
          : Promise.resolve(null),
      ])
      const rows = /** @type {{id: number, name: string, level: number, parent_field_id: number | null}[]} */ (fields)
      const byId = new Map(rows.map((row) => [Number(row.id), row]))
      const paths = new Map()
      /** @param {number} id @param {Set<number>} [visiting] */
      function fieldPath(id, visiting = new Set()) {
        if (paths.has(id)) return paths.get(id)
        const field = byId.get(id)
        if (!field) return null
        if (visiting.has(id)) throw new Error('Collection field hierarchy contains a cycle')
        visiting.add(id)
        const parentId = field.parent_field_id === null ? null : Number(field.parent_field_id)
        const parentPath = parentId === null ? '' : fieldPath(parentId, visiting)
        visiting.delete(id)
        if (parentId !== null && parentPath === null) return null
        const resolved = parentId === null ? '' : parentPath ? `${parentPath}.${field.name}` : field.name
        paths.set(id, resolved)
        return resolved
      }
      const structureByPath = new Map()
      /** @param {any} node */
      function visitStructure(node) {
        if (!node) return
        structureByPath.set(node.path, node)
        for (const child of node.children || []) visitStructure(child)
      }
      visitStructure(structure?.root)
      const openCollection = diagnostics.openCollections.find(
        (candidate) => candidate.collection.toLowerCase() === collection.toLowerCase(),
      )
      const documentCount = structure?.documentCount ??
        Number(/** @type {any[]} */ (totals)[0]?.count || 0)
      return {
        databaseId: entry.id,
        collection,
        documentCount,
        statisticsIncluded: includeStatistics,
        fields: rows.map((row) => {
          const id = Number(row.id)
          const path = fieldPath(id)
          const node = structureByPath.get(path)
          return {
            id,
            name: row.name,
            level: Number(row.level),
            parentFieldId: row.parent_field_id === null ? null : Number(row.parent_field_id),
            path,
            types: includeStatistics ? node?.types ?? [] : null,
            presentInDocuments: includeStatistics ? node?.presentInDocuments ?? 0 : null,
            coverage: includeStatistics ? node?.coverage ?? 0 : null,
            optional: includeStatistics ? node?.optional ?? true : null,
            coverageWithinParent: includeStatistics ? node?.coverageWithinParent ?? 0 : null,
            optionalWithinParent: includeStatistics ? node?.optionalWithinParent ?? true : null,
            indexed: includeStatistics ? node?.indexed === true : false,
          }
        }),
        fieldIndexes: openCollection?.fieldIndexes ??
          entry.inspection.collections.find((item) => item.collection === collection)?.fieldIndexes ??
          null,
        autoIndexing: openCollection?.autoIndexing ?? null,
      }
    } catch (error) {
      throw operationError(error, 'schema_failed')
    }
  }

  /** @param {DatabaseEntry} entry @param {AbortSignal} signal */
  async function databaseDiagnostics(entry, signal) {
    const engine = await engineFor(entry, signal)
    try {
      const [diagnostics, storage] = await Promise.all([
        engine.diagnostics({ signal, timeoutMs: configuration.queryTimeoutMs }),
        engine.storageStats({ signal, timeoutMs: configuration.queryTimeoutMs }),
      ])
      return {
        database: { id: entry.id, name: entry.name },
        engine: {
          mode: diagnostics.mode,
          state: diagnostics.state,
          schemaVersion: diagnostics.schemaVersion,
          busyTimeoutMs: diagnostics.busyTimeoutMs,
          durability: diagnostics.durability,
          fieldIndexes: diagnostics.fieldIndexes,
          operations: diagnostics.operations,
          cache: diagnostics.cache,
          collections: diagnostics.collections,
          openCollections: diagnostics.openCollections.map((collection) => {
            const { databasePath: _databasePath, blobPath: _blobPath, ...safe } = collection
            return safe
          }),
        },
        storage: {
          fileBytes: storage.fileBytes,
          reclaimableBytes: storage.reclaimableBytes,
          collections: storage.collections,
        },
      }
    } catch (error) {
      throw operationError(error, 'diagnostics_failed')
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {URL} url
   * @param {AbortSignal} signal
   */
  async function routeApi(request, response, url, signal) {
    if (!authenticated(request)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="node-idb Studio"')
      throw new HttpError(401, 'unauthorized', 'A valid Studio launch token is required')
    }
    const method = request.method || 'GET'
    const pathname = url.pathname

    if (method === 'GET' && pathname === '/api/state') {
      sendJson(response, 200, publicState())
      return
    }
    if (method === 'POST' && pathname === '/api/refresh') {
      const body = requestObject(await readJson(request, signal), 'refresh body')
      assertKnownKeys(body, [], 'refresh body property')
      const state = await refreshCatalog()
      if (signal.aborted) throw signal.reason
      sendJson(response, 200, state)
      return
    }
    if (method === 'POST' && pathname === '/api/query') {
      const body = requestObject(await readJson(request, signal), 'query body')
      assertKnownKeys(body, ['databaseId', 'statement', 'parameters', 'limit'], 'query body property')
      const entry = findDatabase(body.databaseId)
      const statement = nonEmptyString(body.statement, 'statement')
      if (statement.length > 100_000) throw new RangeError('statement cannot exceed 100000 characters')
      assertSingleSelect(statement)
      await knownSelectCollection(entry, statement)
      const limit = body.limit === undefined
        ? configuration.maxRows
        : boundedPositiveInteger(body.limit, 'limit', configuration.maxRows)
      const parameters = Object.hasOwn(body, 'parameters')
        ? decodeWire(body.parameters, 'parameters')
        : undefined
      const engine = await engineFor(entry, signal)
      const rowNodes = []
      let responseBytes = 0
      let truncated = false
      const started = performance.now()
      try {
        for await (const row of engine.stream(statement, parameters, {
          batchSize: Math.min(25, limit + 1),
          signal,
          timeoutMs: configuration.queryTimeoutMs,
        })) {
          if (rowNodes.length === limit) {
            truncated = true
            break
          }
          const node = encodeResponseValue(row)
          responseBytes = addToResponseBudget(responseBytes, node)
          rowNodes.push(node)
        }
      } catch (error) {
        throw operationError(error, 'query_failed')
      }
      sendJson(response, 200, {
        rows: ['array', rowNodes],
        rowCount: rowNodes.length,
        truncated,
        limit,
        durationMs: Number((performance.now() - started).toFixed(3)),
      })
      return
    }
    if (method === 'POST' && pathname === '/api/documents/list') {
      const body = requestObject(await readJson(request, signal), 'document list body')
      assertKnownKeys(
        body,
        ['databaseId', 'collection', 'limit', 'offset', 'order'],
        'document list body property',
      )
      const entry = findDatabase(body.databaseId)
      const collection = knownCollection(entry, body.collection)
      const limit = body.limit === undefined
        ? Math.min(50, configuration.maxRows)
        : boundedPositiveInteger(body.limit, 'limit', configuration.maxRows)
      const offset = body.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError('offset must be a non-negative safe integer')
      }
      const order = body.order ?? 'asc'
      if (order !== 'asc' && order !== 'desc') {
        throw new TypeError('order must be either "asc" or "desc"')
      }
      const engine = await engineFor(entry, signal)
      const quoted = quoteIdentifier(collection)
      try {
        const [idRows, countRows] = await Promise.all([
          engine.execute(
            `SELECT object_id FROM ${quoted} ORDER BY object_id ${order.toUpperCase()} LIMIT ? OFFSET ?`,
            [limit, offset],
            { signal, timeoutMs: configuration.queryTimeoutMs },
          ),
          engine.execute(
            `SELECT COUNT(*) AS count FROM ${quoted}`,
            undefined,
            { signal, timeoutMs: configuration.queryTimeoutMs },
          ),
        ])
        const ids = /** @type {{object_id: number}[]} */ (idRows).map((row) => objectId(row.object_id))
        const documents = []
        let responseBytes = 0
        for (let start = 0; start < ids.length; start += 25) {
          const chunkIds = ids.slice(start, start + 25)
          const chunk = /** @type {unknown[]} */ (await engine.execute(
            `SELECT * FROM ${quoted} WHERE object_id IN (${chunkIds.join(', ')}) ORDER BY object_id ${order.toUpperCase()}`,
            undefined,
            { signal, timeoutMs: configuration.queryTimeoutMs },
          ))
          if (chunk.length !== chunkIds.length) {
            throw new HttpError(
              409,
              'document_page_changed',
              'Documents changed while the page was being read; reload the collection',
            )
          }
          for (let index = 0; index < chunk.length; index++) {
            const item = {
              objectId: chunkIds[index],
              document: encodeResponseValue(chunk[index]),
            }
            responseBytes = addToResponseBudget(responseBytes, item)
            documents.push(item)
          }
        }
        sendJson(response, 200, {
          documents,
          total: Number(/** @type {any[]} */ (countRows)[0]?.count || 0),
          limit,
          offset: Number(offset),
          order,
          hasMore: Number(offset) + ids.length < Number(/** @type {any[]} */ (countRows)[0]?.count || 0),
        })
      } catch (error) {
        throw operationError(error, 'document_list_failed')
      }
      return
    }
    if (method === 'POST' && pathname === '/api/documents/insert') {
      const body = requestObject(await readJson(request, signal), 'insert body')
      requireWritable()
      assertKnownKeys(body, ['databaseId', 'collection', 'document'], 'insert body property')
      if (!Object.hasOwn(body, 'document')) throw new TypeError('insert body requires document')
      const entry = findDatabase(body.databaseId)
      const collection = knownCollection(entry, body.collection)
      const document = decodeWire(body.document, 'document')
      const engine = await engineFor(entry, signal)
      try {
        const ids = /** @type {number[]} */ (await engine.execute(
          `INSERT INTO ${quoteIdentifier(collection)}`,
          [document],
          { signal, timeoutMs: configuration.queryTimeoutMs },
        ))
        if (ids.length !== 1) throw new Error('Insert did not return exactly one object ID')
        sendJson(response, 201, { objectId: objectId(ids[0]) })
      } catch (error) {
        throw operationError(error, 'insert_failed')
      }
      return
    }
    if (
      method === 'POST' &&
      (pathname === '/api/documents/replace' || pathname === '/api/documents/update')
    ) {
      const action = pathname.endsWith('/replace') ? 'replace' : 'update'
      const body = requestObject(await readJson(request, signal), `${action} body`)
      requireWritable()
      assertKnownKeys(
        body,
        ['databaseId', 'collection', 'objectId', 'document'],
        `${action} body property`,
      )
      if (!Object.hasOwn(body, 'document')) throw new TypeError(`${action} body requires document`)
      const entry = findDatabase(body.databaseId)
      const collection = knownCollection(entry, body.collection)
      const id = objectId(body.objectId)
      const document = decodeWire(body.document, 'document')
      if (action === 'update' && !isPlainObject(document)) {
        throw new HttpError(400, 'invalid_update', 'Update document must be a plain object')
      }
      if (action === 'replace' && Array.isArray(document)) {
        throw new HttpError(
          422,
          'root_array_replace_unsupported',
          'Replacing with a root array is unavailable because the current core API treats arrays as batch payloads; insert the array as a new document instead',
        )
      }
      const engine = await engineFor(entry, signal)
      const quoted = quoteIdentifier(collection)
      try {
        const command = action === 'replace' ? 'REPLACE INTO' : 'UPDATE'
        const result = /** @type {{object_id: number}[]} */ (await engine.execute(
          `${command} ${quoted} WHERE object_id = ${id}`,
          document,
          {
            signal,
            timeoutMs: configuration.queryTimeoutMs,
            ...(action === 'replace' ? { requireMatch: true } : {}),
          },
        ))
        if (!result.length) {
          throw new HttpError(404, 'document_not_found', 'Document no longer exists')
        }
        sendJson(response, 200, { objectId: id, updated: true })
      } catch (error) {
        throw operationError(error, `${action}_failed`)
      }
      return
    }
    if (method === 'POST' && pathname === '/api/documents/delete') {
      const body = requestObject(await readJson(request, signal), 'delete body')
      requireWritable()
      assertKnownKeys(
        body,
        ['databaseId', 'collection', 'objectId', 'confirm'],
        'delete body property',
      )
      if (body.confirm !== true) {
        throw new HttpError(400, 'confirmation_required', 'delete body must include confirm: true')
      }
      const entry = findDatabase(body.databaseId)
      const collection = knownCollection(entry, body.collection)
      const id = objectId(body.objectId)
      const engine = await engineFor(entry, signal)
      try {
        const result = /** @type {{object_id: number}[]} */ (await engine.execute(
          `DELETE FROM ${quoteIdentifier(collection)} WHERE object_id = ?`,
          [id],
          { signal, timeoutMs: configuration.queryTimeoutMs },
        ))
        if (!result.length) throw new HttpError(404, 'document_not_found', 'Document does not exist')
        sendJson(response, 200, { objectId: id, deleted: true })
      } catch (error) {
        throw operationError(error, 'delete_failed')
      }
      return
    }

    const schemaMatch = /^\/api\/databases\/([^/]+)\/collections\/([^/]+)\/schema$/.exec(pathname)
    if (method === 'GET' && schemaMatch) {
      const entry = findDatabase(decodePathSegment(schemaMatch[1], 'database ID'))
      const collection = knownCollection(entry, decodePathSegment(schemaMatch[2], 'collection'))
      sendJson(
        response,
        200,
        await collectionSchema(entry, collection, signal, url.searchParams.get('summary') !== '1'),
      )
      return
    }
    const diagnosticsMatch = /^\/api\/databases\/([^/]+)\/diagnostics$/.exec(pathname)
    if (method === 'GET' && diagnosticsMatch) {
      const entry = findDatabase(decodePathSegment(diagnosticsMatch[1], 'database ID'))
      sendJson(response, 200, await databaseDiagnostics(entry, signal))
      return
    }
    const analyzeMatch = /^\/api\/databases\/([^/]+)\/analyze$/.exec(pathname)
    if (method === 'POST' && analyzeMatch) {
      const body = requestObject(await readJson(request, signal), 'analyze body')
      requireWritable()
      assertKnownKeys(body, ['collection'], 'analyze body property')
      const entry = findDatabase(decodePathSegment(analyzeMatch[1], 'database ID'))
      const collection = body.collection === undefined ? undefined : knownCollection(entry, body.collection)
      const engine = await engineFor(entry, signal)
      try {
        const result = await engine.analyze({
          ...(collection ? { collections: [collection] } : {}),
          signal,
          timeoutMs: configuration.queryTimeoutMs,
        })
        sendJson(response, 200, { result: encodeResponseValue(result) })
      } catch (error) {
        throw operationError(error, 'analyze_failed')
      }
      return
    }
    const optimizeMatch = /^\/api\/databases\/([^/]+)\/optimize-indexes$/.exec(pathname)
    if (method === 'POST' && optimizeMatch) {
      const body = requestObject(await readJson(request, signal), 'optimize indexes body')
      requireWritable()
      assertKnownKeys(body, ['collection', 'dryRun'], 'optimize indexes body property')
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        throw new TypeError('dryRun must be a boolean')
      }
      const entry = findDatabase(decodePathSegment(optimizeMatch[1], 'database ID'))
      const collection = body.collection === undefined ? undefined : knownCollection(entry, body.collection)
      const engine = await engineFor(entry, signal)
      try {
        const result = await engine.optimizeIndexes({
          ...(collection ? { collections: [collection] } : {}),
          dryRun: body.dryRun === true,
          signal,
          timeoutMs: configuration.queryTimeoutMs,
        })
        sendJson(response, 200, { result: encodeResponseValue(result) })
      } catch (error) {
        throw operationError(error, 'optimize_indexes_failed')
      }
      return
    }

    throw new HttpError(404, 'api_not_found', 'Studio API endpoint not found')
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {URL} url
   */
  async function routeStatic(request, response, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      throw new HttpError(405, 'method_not_allowed', 'Static Studio assets support GET and HEAD')
    }
    if (url.pathname === '/favicon.ico') {
      response.statusCode = 204
      response.end()
      return
    }
    const asset = staticAssets[url.pathname]
    if (!asset) throw new HttpError(404, 'not_found', 'Studio page not found')
    let body
    try {
      body = await readFile(path.join(publicDirectory, asset.file))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new HttpError(404, 'asset_not_found', 'Studio asset is not installed')
      }
      throw error
    }
    response.statusCode = 200
    response.setHeader('Content-Type', asset.type)
    response.setHeader('Content-Length', body.length)
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  const server = createServer((request, response) => {
    void (async () => {
      let api = false
      let deadline
      const requestController = new AbortController()
      const disconnected = new Error('Studio client disconnected')
      // @ts-ignore custom code keeps timeout and disconnect aborts distinguishable.
      disconnected.code = 'STUDIO_CLIENT_DISCONNECTED'
      const onAborted = () => requestController.abort(disconnected)
      const onResponseClose = () => {
        if (!response.writableEnded) requestController.abort(disconnected)
      }
      request.once('aborted', onAborted)
      response.once('close', onResponseClose)
      try {
        if (!validHost(request)) throw new HttpError(421, 'invalid_host', 'Invalid Studio Host header')
        if (!validOrigin(request)) throw new HttpError(403, 'invalid_origin', 'Cross-origin Studio request rejected')
        const url = new URL(request.url || '/', `http://${host}:${boundPort}`)
        api = url.pathname === '/api' || url.pathname.startsWith('/api/')
        if (api) {
          const timeout = new Error('Studio request exceeded its overall deadline')
          // @ts-ignore custom code is inspected in the request error boundary.
          timeout.code = 'STUDIO_REQUEST_TIMEOUT'
          deadline = setTimeout(
            () => requestController.abort(timeout),
            configuration.queryTimeoutMs,
          )
          deadline.unref?.()
        }
        secureHeaders(response, api ? 'api' : 'static')
        if (closing) throw new HttpError(503, 'studio_closing', 'Studio is closing')
        if (api) await routeApi(request, response, url, requestController.signal)
        else await routeStatic(request, response, url)
      } catch (error) {
        if (response.destroyed || response.headersSent || response.writableEnded) {
          if (!response.writableEnded) response.end()
          return
        }
        secureHeaders(response, api ? 'api' : 'static')
        const reason = requestController.signal.reason
        const failure = reason &&
          typeof reason === 'object' &&
          'code' in reason &&
          reason.code === 'STUDIO_REQUEST_TIMEOUT'
          ? new HttpError(504, 'request_timeout', 'Studio request exceeded its overall deadline')
          : error instanceof HttpError
          ? error
          : error instanceof TypeError || error instanceof RangeError
            ? new HttpError(400, 'invalid_request', error.message)
            : new HttpError(500, 'internal_error', 'Studio could not complete the request')
        if (failure.status === 413) response.setHeader('Connection', 'close')
        sendJson(response, failure.status, {
          error: { code: failure.code, message: sanitizeMessage(failure.message) },
        }, request.method === 'HEAD')
      } finally {
        if (deadline) clearTimeout(deadline)
        request.off('aborted', onAborted)
        response.off('close', onResponseClose)
      }
    })()
  })
  server.headersTimeout = 10_000
  server.requestTimeout = Math.max(15_000, configuration.queryTimeoutMs + 5_000)
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 50
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  await refreshCatalog()
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(undefined)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host, port: configuration.port, exclusive: true })
    })
  } catch (error) {
    closing = true
    await Promise.all([...engines.values()].map(({ engine }) => engine.close().catch(() => {})))
    closed = true
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Studio server did not expose a TCP address')
  }
  boundPort = address.port

  async function close() {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      server.closeIdleConnections?.()
      const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve(undefined))
      })
      await Promise.allSettled(
        [refreshInFlight, refreshFollowUp].filter(Boolean),
      )
      await Promise.allSettled([...openingEngines.values()].map(({ promise }) => promise))
      await Promise.all([
        serverClosed,
        ...[...new Set([...engines.values()].map(({ engine }) => engine))]
          .map((engine) => engine.close().catch(() => {})),
      ])
      engines.clear()
      closed = true
    })()
    return closePromise
  }

  const url = `http://${host}:${boundPort}/#token=${encodeURIComponent(token)}`
  return Object.freeze({
    url,
    host,
    port: boundPort,
    rootPath: rootRealPath,
    writable: configuration.writable,
    get closed() { return closed },
    refresh: refreshCatalog,
    close,
  })
}
