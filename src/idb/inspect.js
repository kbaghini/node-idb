// @ts-check

import { stat } from 'node:fs/promises'
import path from 'node:path'

import sqlite3 from 'sqlite3'

import { checkSqliteIntegrity } from './backup.js'
import { closeDatabase, get, openDatabase } from './database.js'
import { abortError, throwIfAborted, validateAbortSignal } from './operation.js'
import { StorageCatalog } from './storage.js'

/**
 * Inspects collection pairs without migrating or otherwise changing them.
 * @param {{
 *   storagePath: string,
 *   integrityCheck?: 'none' | 'quick' | 'full',
 *   signal?: AbortSignal,
 * }} options
 */
export async function inspectStorage(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('inspectStorage requires an options object')
  }
  const unknown = Object.keys(options).filter(
    (key) => !['storagePath', 'integrityCheck', 'signal'].includes(key),
  )
  if (unknown.length) throw new TypeError(`Unknown inspectStorage option: ${unknown.join(', ')}`)
  const { storagePath, integrityCheck = 'quick', signal } = options
  if (typeof storagePath !== 'string' || !storagePath.length || storagePath === ':memory:') {
    throw new TypeError('inspectStorage storagePath must be a filesystem path')
  }
  if (storagePath.includes('\0')) throw new TypeError('storagePath must not contain null bytes')
  if (!['none', 'quick', 'full'].includes(integrityCheck)) {
    throw new TypeError('integrityCheck must be "none", "quick", or "full"')
  }
  validateAbortSignal(signal)
  throwIfAborted(signal)

  const resolvedPath = path.resolve(storagePath)
  const pairs = await new StorageCatalog(resolvedPath).refresh()
  const collections = []
  for (const pair of pairs) {
    throwIfAborted(signal)
    if (integrityCheck !== 'none') {
      await checkSqliteIntegrity(pair.databasePath, { mode: integrityCheck, signal })
      await checkSqliteIntegrity(pair.blobPath, { mode: integrityCheck, signal })
    }
    const database = await openDatabase(
      pair.databasePath,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_URI | sqlite3.OPEN_FULLMUTEX,
    )
    const interrupt = () => database.interrupt()
    signal?.addEventListener('abort', interrupt, { once: true })
    try {
      const versionRow = await get(database, 'PRAGMA main.user_version')
      let fieldIndexes = null
      try {
        const setting = await get(
          database,
          'SELECT value FROM tbl_settings WHERE key = ?',
          ['field_indexes'],
        )
        if (typeof setting?.value === 'string') {
          try {
            fieldIndexes = JSON.parse(setting.value)
          } catch {
            fieldIndexes = setting.value
          }
        }
      } catch {
        // Older schemas may not have tbl_settings yet. Inspection must remain
        // non-mutating and report that absence instead of attempting repair.
      }
      const [databaseFile, blobFile] = await Promise.all([
        stat(pair.databasePath),
        stat(pair.blobPath),
      ])
      collections.push(Object.freeze({
        collection: pair.collection,
        schemaVersion: Number(versionRow?.user_version || 0),
        fieldIndexes,
        files: Object.freeze({
          collection: Object.freeze({ path: pair.databasePath, bytes: databaseFile.size }),
          blobs: Object.freeze({ path: pair.blobPath, bytes: blobFile.size }),
        }),
      }))
      throwIfAborted(signal)
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      throw error
    } finally {
      signal?.removeEventListener('abort', interrupt)
      await closeDatabase(database).catch(() => {})
    }
  }
  return Object.freeze({
    storagePath: resolvedPath,
    integrityCheck,
    totalBytes: collections.reduce(
      (total, collection) => total + collection.files.collection.bytes + collection.files.blobs.bytes,
      0,
    ),
    collections: Object.freeze(collections),
  })
}
