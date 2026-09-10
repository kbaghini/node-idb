import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { verifyBackup, restoreBackup } from '../idb/backup.js'
import { encodeStudioValue, decodeStudioValue } from './codec.js'

const format = 'node-idb-transfer'
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const quote = value => '`' + value.replaceAll('`', '``') + '`'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function readTransfer(bundle, maxRows) {
  if (!plain(bundle) || bundle.format !== format || bundle.version !== 1 ||
      !Array.isArray(bundle.documents) || !bundle.documents.length || bundle.documents.length > maxRows) {
    throw new TypeError(`Choose a version 1 node-idb transfer package with 1–${maxRows} documents`)
  }
  const documents = bundle.documents.map(node => decodeStudioValue(node))
  if (documents.some(document => !plain(document))) throw new TypeError('Every imported document must be a plain object')
  return documents
}

// Canonicalize object entry order without changing arrays or native types.
function signature(value) {
  const wire = encodeStudioValue(value)
  function ordered(node) {
    if (node[0] === 'object') return ['object', [...node[1]].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])]
    if (node[0] === 'array') return ['array', node[1].map(ordered)]
    return node
  }
  return digest(ordered(wire))
}

export function compareDocuments(left, right, keyPath) {
  if (typeof keyPath !== 'string' || !keyPath.trim() || keyPath.length > 256) throw new TypeError('Enter a unique field path, such as sku or contact.email')
  const parts = keyPath.split('.')
  if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new TypeError('Invalid comparison key')
  function index(documents) {
    const result = new Map()
    for (const document of documents) {
      let key = document
      for (const part of parts) key = key != null && Object.hasOwn(key, part) ? key[part] : undefined
      if (!['string', 'number', 'bigint', 'boolean'].includes(typeof key) || (typeof key === 'number' && !Number.isFinite(key))) throw new TypeError('Every document must have a scalar comparison key')
      const id = JSON.stringify(encodeStudioValue(key))
      if (result.has(id)) throw new TypeError('Comparison keys must be unique in each collection')
      result.set(id, { key: encodeStudioValue(key), document, hash: signature(document) })
    }
    return result
  }
  const before = index(left), after = index(right)
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 }
  const differences = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id)
    const kind = !a ? 'added' : !b ? 'removed' : a.hash === b.hash ? 'unchanged' : 'changed'
    counts[kind]++
    if (kind !== 'unchanged' && differences.length < 100) differences.push({ kind, key: (b || a).key,
      before: a ? encodeStudioValue(a.document) : null, after: b ? encodeStudioValue(b.document) : null })
  }
  return { counts, differences, truncated: counts.added + counts.removed + counts.changed > differences.length }
}

export function createWorkspaceRoutes(context) {
  const { configuration, rootRealPath, findDatabase, knownCollection, engineFor, requireWritable, readJson, requestObject, sendJson, HttpError, refreshCatalog } = context
  const previews = new Map()
  let backupRoot = null
  let backupIdentity = null
  async function checkedBackupRoot() {
    if (!configuration.backupPath) throw new HttpError(403, 'backups_disabled', 'Set backupPath when starting Studio to enable managed backups')
    if (!backupRoot) {
      await mkdir(configuration.backupPath, { recursive: true })
      const candidate = await realpath(configuration.backupPath)
      if (within(rootRealPath, candidate) || within(candidate, rootRealPath)) throw new TypeError('backupPath must be outside rootPath')
      const info = await lstat(candidate)
      backupRoot = candidate
      backupIdentity = `${info.dev}:${info.ino}`
    }
    const info = await lstat(backupRoot)
    if (!info.isDirectory() || info.isSymbolicLink() || `${info.dev}:${info.ino}` !== backupIdentity || await realpath(configuration.backupPath) !== backupRoot) throw new Error('Backup directory changed; restart Studio')
    return backupRoot
  }
  function within(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
  async function backupLocation(id) {
    if (typeof id !== 'string' || !/^snapshot-[0-9a-f-]{36}$/.test(id)) throw new TypeError('Invalid backup ID')
    const parent = await checkedBackupRoot(), candidate = path.join(parent, id)
    const info = await lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== candidate) throw new TypeError('Backup must be a managed directory')
    return candidate
  }
  async function snapshot(databaseId, requested, signal) {
    const entry = findDatabase(databaseId), collection = knownCollection(entry, requested)
    const engine = await engineFor(entry, signal), documents = []
    let bytes = 1024
    for await (const document of engine.stream(`SELECT * FROM ${quote(collection)} ORDER BY object_id`, undefined,
      { signal, timeoutMs: configuration.queryTimeoutMs, batchSize: 25 })) {
      const node = encodeStudioValue(document)
      bytes += Buffer.byteLength(JSON.stringify(node)) + 1
      if (documents.length >= configuration.maxTransferRows || bytes > configuration.bodyLimitBytes - 8192) throw new HttpError(413, 'transfer_too_large', 'Collection exceeds transfer limits; increase maxTransferRows/bodyLimitBytes or use the core streaming API')
      documents.push(node)
    }
    return { format, version: 1, createdAt: new Date().toISOString(), source: { database: entry.name, collection }, documents }
  }
  return async (request, response, url, signal) => {
    if (!url.pathname.startsWith('/api/workspace/')) return false
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST')
    const body = requestObject(await readJson(request, signal), 'workspace body')
    const action = url.pathname.slice('/api/workspace/'.length)
    if (configuration.embed && ['backups', 'backup', 'verify-backup', 'restore-backup'].includes(action)) {
      throw new HttpError(403, 'operator_only', 'Shared backup management is available only in local operator Studio')
    }
    const options = { signal, timeoutMs: configuration.queryTimeoutMs }
    let result
    if (action === 'export') {
      result = await snapshot(body.databaseId, body.collection, signal)
    } else if (action === 'compare') {
      const left = await snapshot(body.databaseId, body.collection, signal)
      const right = await snapshot(body.targetDatabaseId, body.targetCollection, signal)
      result = compareDocuments(left.documents.map(node => decodeStudioValue(node)), right.documents.map(node => decodeStudioValue(node)), body.keyPath)
    } else if (action === 'preview-import') {
      const entry = findDatabase(body.databaseId), collection = knownCollection(entry, body.collection)
      const documents = readTransfer(body.bundle, configuration.maxTransferRows)
      for (const [id, preview] of previews) if (preview.expiresAt < Date.now()) previews.delete(id)
      if (previews.size >= 10) previews.delete(previews.keys().next().value)
      const ticket = randomUUID(), expiresAt = Date.now() + 10 * 60_000
      previews.set(ticket, { documents, databaseId: entry.id, fingerprint: entry.fingerprint, collection, expiresAt, subject: context.currentSubject?.() || 'local' })
      result = { ticket, expiresAt, count: documents.length, sha256: digest(body.bundle), mode: 'append',
        sample: documents.slice(0, 3).map(document => encodeStudioValue(document)) }
    } else if (action === 'apply-import') {
      requireWritable()
      const preview = previews.get(body.ticket)
      if (!preview || preview.expiresAt < Date.now() || preview.subject !== (context.currentSubject?.() || 'local')) throw new HttpError(409, 'preview_expired', 'Preview expired or already applied; review the file again')
      if (body.confirm !== true || body.databaseId !== preview.databaseId || body.collection !== preview.collection) throw new HttpError(409, 'preview_mismatch', 'Confirm the preview for this destination')
      const entry = findDatabase(preview.databaseId)
      if (entry.fingerprint !== preview.fingerprint) throw new HttpError(409, 'database_changed', 'Database changed; review the file again')
      const engine = await engineFor(entry, signal)
      // Consume before awaiting the write so double-clicks cannot append twice.
      if (previews.get(body.ticket) !== preview) throw new HttpError(409, 'preview_used', 'Preview already applied')
      previews.delete(body.ticket)
      try {
        const ids = await engine.execute(`INSERT INTO ${quote(preview.collection)}`, preview.documents, options)
        result = { inserted: ids.length }
      } catch (error) {
        throw new HttpError(422, 'import_failed', error instanceof Error ? error.message : 'Import failed')
      }
    } else if (action === 'backups') {
      const parent = await checkedBackupRoot()
      const backups = []
      for (const item of await readdir(parent, { withFileTypes: true })) {
        if (signal.aborted) throw signal.reason
        if (!item.isDirectory() || !/^snapshot-[0-9a-f-]{36}$/.test(item.name)) continue
        const info = await lstat(path.join(parent, item.name))
        backups.push({ id: item.name, createdAt: info.birthtime.toISOString() })
      }
      result = { backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
    } else if (action === 'backup') {
      const entry = findDatabase(body.databaseId), engine = await engineFor(entry, signal)
      const parent = await checkedBackupRoot(), id = `snapshot-${randomUUID()}`
      const backup = await engine.backup({ destinationPath: path.join(parent, id), signal })
      result = { id, createdAt: backup.createdAt, collections: backup.collections }
    } else if (action === 'verify-backup') {
      const report = await verifyBackup({ backupPath: await backupLocation(body.id), integrityCheck: 'full', signal })
      result = { id: body.id, createdAt: report.createdAt, collections: report.collections, verified: true }
    } else if (action === 'restore-backup') {
      requireWritable()
      if (body.confirm !== true) throw new TypeError('Confirm restoration to a new database')
      const source = await backupLocation(body.id)
      if (await realpath(configuration.rootPath) !== rootRealPath) throw new Error('Database root changed; restart Studio')
      const name = `restored-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
      await restoreBackup({ backupPath: source, destinationPath: path.join(rootRealPath, name), integrityCheck: 'full', signal })
      await refreshCatalog()
      result = { database: name }
    } else throw new HttpError(404, 'not_found', 'Unknown workspace action')
    sendJson(response, 200, result)
    return true
  }
}
