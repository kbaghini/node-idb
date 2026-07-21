// @ts-check

import { pathToFileURL } from 'node:url'
import { open as openFile, stat } from 'node:fs/promises'

import sqlite3 from 'sqlite3'

import { ValueType, decodeValue, encodeDocument } from './codec.js'
import {
  all,
  chunks,
  closeDatabase,
  exec,
  get,
  openDatabase,
  quoteSqlString,
  run,
  transaction,
} from './database.js'
import { deserializeFieldIndexes } from './field-indexes.js'
import { throwIfAborted, withDatabaseInterrupt } from './operation.js'

const schemaVersion = 5
const fieldIndexesSetting = 'field_indexes'
const validValueTypes = new Set(Object.values(ValueType).map(Number))
const logicalValueTypes = Object.freeze(new Map([
  [ValueType.null, 'null'],
  [ValueType.true, 'boolean'],
  [ValueType.false, 'boolean'],
  [ValueType.bigint, 'bigint'],
  [ValueType.number, 'number'],
  [ValueType.date, 'date'],
  [ValueType.string, 'string'],
  [ValueType.text, 'string'],
  [ValueType.array, 'array'],
  [ValueType.object, 'object'],
  [ValueType.binary, 'binary'],
]))
const logicalValueTypeOrder = Object.freeze([
  'object', 'array', 'string', 'number', 'bigint', 'boolean', 'date', 'binary', 'null',
])

/** @param {string} filename @param {string} label */
async function assertRollbackJournalFile(filename, label) {
  const handle = await openFile(filename, 'r')
  try {
    const header = Buffer.alloc(100)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 20 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
      throw new Error(`${label} is not a supported SQLite database`)
    }
    if (header[18] !== 1 || header[19] !== 1) {
      throw new Error(
        `${label} uses WAL or an unsupported journal format; open it once in readwrite mode to convert it to DELETE journal mode`,
      )
    }
  } finally {
    await handle.close()
  }
}

/**
 * @typedef {{ id: number, name: string, level: number, parent_field_id: number | null, path: string }} Field
 */

const valueExpression = `CASE
  WHEN v.type = 0 THEN NULL
  WHEN v.type = 1 THEN 1
  WHEN v.type = 2 THEN 0
  WHEN v.type = 3 THEN v.string
  WHEN v.type IN (4, 5, 9) THEN v.number
  WHEN v.type = 6 THEN v.string
  WHEN v.type IN (7, 8, 10) THEN (
    SELECT b.blob FROM blobs.tbl_blobs b WHERE b.id = v.id
  )
  ELSE COALESCE(v.number, v.string)
END`

/**
 * Scalar expression mirrored by each field table's expression index.
 * @param {string} [alias]
 */
export function indexedValueExpression(alias = '') {
  const column = (/** @type {string} */ name) => alias ? `${alias}.${name}` : name
  return `CASE
    WHEN ${column('type')} = 0 THEN NULL
    WHEN ${column('type')} = 1 THEN 1
    WHEN ${column('type')} = 2 THEN 0
    WHEN ${column('type')} = 3 THEN ${column('string')}
    WHEN ${column('type')} IN (4, 5, 9) THEN ${column('number')}
    WHEN ${column('type')} = 6 THEN ${column('string')}
    ELSE COALESCE(${column('number')}, ${column('string')})
  END`
}

/** @param {number} fieldId */
export function valueTable(fieldId) {
  if (!Number.isSafeInteger(fieldId) || fieldId < 1) throw new Error('Invalid field id')
  return `tbl_values_${fieldId}`
}

/** @param {number} fieldId @param {boolean} [predicateIndexes] */
function valueTableSchema(fieldId, predicateIndexes = true) {
  const table = valueTable(fieldId)
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY,
      type INTEGER NOT NULL,
      number NUMERIC,
      string TEXT,
      parent_id INTEGER,
      object_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_values_${fieldId}_object_parent
      ON ${table} (object_id, parent_id, id);
    ${predicateIndexes ? `
      CREATE INDEX IF NOT EXISTS idx_values_${fieldId}_query_object
        ON ${table} ((${indexedValueExpression()}), object_id);
      CREATE INDEX IF NOT EXISTS idx_values_${fieldId}_type_object
        ON ${table} (type, object_id);
    ` : `
      DROP INDEX IF EXISTS idx_values_${fieldId}_query_object;
      DROP INDEX IF EXISTS idx_values_${fieldId}_type_object;
    `}
    DROP INDEX IF EXISTS idx_values_${fieldId}_object_id;
  `
}

/**
 * A single collection connection. The blob database is attached to the main
 * connection so document mutations commit atomically across both files. The
 * on-disk stores deliberately use rollback journals rather than WAL: SQLite's
 * super-journal can only make an attached multi-database commit crash-atomic
 * when none of the participating databases uses WAL.
 */
export class CollectionStore {
  /**
   * @param {{
   *   collection: string,
   *   databasePath: string,
   *   blobPath: string,
   *   memory: boolean,
   *   existing: boolean,
   *   mode: 'readwrite' | 'readonly',
   *   busyTimeoutMs: number,
   *   durability: 'strict' | 'balanced',
   *   fieldIndexes: {
   *     serialized: string,
   *     isIndexed(collection: string, fieldPath: string): boolean,
   *   },
   *   fieldIndexesProvided: boolean,
   * }} options
   */
  constructor({
    collection,
    databasePath,
    blobPath,
    memory,
    existing,
    mode,
    busyTimeoutMs,
    durability,
    fieldIndexes,
    fieldIndexesProvided,
  }) {
    this.collection = collection
    this.databasePath = databasePath
    this.blobPath = blobPath
    this.memory = memory
    this.existing = existing
    this.mode = mode
    this.busyTimeoutMs = busyTimeoutMs
    this.durability = durability
    this.requestedFieldIndexes = fieldIndexes
    this.fieldIndexesProvided = fieldIndexesProvided
    this.activeFieldIndexes = fieldIndexes
    /** @type {Map<number, { fieldId: number, path: string, kinds: Set<string>, kindCounts: Record<string, number>, queryCount: number, totalDurationMs: number, slowQueryCount: number, resultRows: number, lastSeenAt: number }>} */
    this.pendingIndexObservations = new Map()
    this.pendingObservationQueries = 0
    this.autoIndexFlushTimer = null
    this.autoIndexFlushPromise = null
    this.lastAutoIndexError = null
    this.lastOptimizeAt = 0
    this.autoIndexDiagnostics = Object.freeze({
      mode: fieldIndexes.mode,
      pendingQueries: 0,
      observedQueries: 0,
      managedIndexes: Object.freeze([]),
      candidates: Object.freeze([]),
      lastEvaluationAt: null,
      lastChangeAt: null,
      lastError: null,
    })
    /** @type {import('sqlite3').Database | null} */
    this.database = null
    /** @type {Field[]} */
    this.fields = []
    /** @type {Map<number, Field>} */
    this.fieldsById = new Map()
    /** @type {Promise<unknown>} */
    this.writeQueue = Promise.resolve()
    this.closed = false
    this.closing = false
    /** @type {Promise<void> | null} */
    this.closePromise = null
  }

  async initialize() {
    if (this.database) return this

    const readOnly = this.mode === 'readonly'
    if (readOnly && !this.memory) {
      await assertRollbackJournalFile(this.databasePath, 'Collection database')
      await assertRollbackJournalFile(this.blobPath, 'Blob database')
    }
    const openMode = readOnly
      ? sqlite3.OPEN_READONLY | sqlite3.OPEN_URI | sqlite3.OPEN_FULLMUTEX
      : this.existing && !this.memory
        ? sqlite3.OPEN_READWRITE | sqlite3.OPEN_URI | sqlite3.OPEN_FULLMUTEX
        : undefined
    const database = await openDatabase(this.databasePath, openMode)
    this.database = database
    try {
      await exec(database, `PRAGMA busy_timeout=${this.busyTimeoutMs};`)
      const versionRow = await get(database, 'PRAGMA main.user_version')
      const version = Number(/** @type {{ user_version?: number } | undefined} */ (versionRow)?.user_version || 0)
      if (version > schemaVersion) {
        throw new Error(
          `Database schema version ${version} is newer than supported version ${schemaVersion}`,
        )
      }
      if (readOnly && version < schemaVersion) {
        throw new Error(
          `Database schema version ${version} requires a writable migration to version ${schemaVersion}`,
        )
      }
      let attachedBlobPath = this.blobPath
      if (!this.memory && (readOnly || this.existing)) {
        const blobUrl = pathToFileURL(this.blobPath)
        blobUrl.searchParams.set('mode', readOnly ? 'ro' : 'rw')
        attachedBlobPath = blobUrl.href
      }
      await run(database, 'ATTACH DATABASE ? AS blobs', [attachedBlobPath])
      if (readOnly) {
        await exec(database, 'PRAGMA query_only=ON;')
      }
      if (!this.memory) {
        const mainJournal = await get(
          database,
          readOnly ? 'PRAGMA main.journal_mode' : 'PRAGMA main.journal_mode=DELETE',
        )
        const blobJournal = await get(
          database,
          readOnly ? 'PRAGMA blobs.journal_mode' : 'PRAGMA blobs.journal_mode=DELETE',
        )
        const mainMode = String(
          /** @type {{ journal_mode?: string } | undefined} */ (mainJournal)?.journal_mode || '',
        ).toLowerCase()
        const blobMode = String(
          /** @type {{ journal_mode?: string } | undefined} */ (blobJournal)?.journal_mode || '',
        ).toLowerCase()
        if (mainMode !== 'delete' || blobMode !== 'delete') {
          throw new Error(
            `IDB requires DELETE journal mode for atomic main/blob commits; received main=${mainMode || 'unknown'}, blobs=${blobMode || 'unknown'}`,
          )
        }
        if (!readOnly) {
          await exec(
            database,
            `PRAGMA main.synchronous=${this.durability === 'strict' ? 'FULL' : 'NORMAL'};
             PRAGMA blobs.synchronous=${this.durability === 'strict' ? 'FULL' : 'NORMAL'};`,
          )
        }
      }
      await exec(
        database,
        `
          PRAGMA main.foreign_keys=ON;
          PRAGMA main.temp_store=MEMORY;
          PRAGMA main.cache_size=-16384;
          PRAGMA main.mmap_size=268435456;
          PRAGMA blobs.cache_size=-8192;
        `,
      )
      if (readOnly) {
        await this.validateReadOnlySchema()
        return this
      }
      await transaction(database, async () => {
        const lockedVersionRow = await get(database, 'PRAGMA main.user_version')
        const lockedVersion = Number(
          /** @type {{ user_version?: number } | undefined} */ (lockedVersionRow)?.user_version || 0,
        )
        if (lockedVersion > schemaVersion) {
          throw new Error(
            `Database schema version ${lockedVersion} is newer than supported version ${schemaVersion}`,
          )
        }
        await exec(
          database,
          `
          CREATE TABLE IF NOT EXISTS tbl_record (
            collection TEXT UNIQUE NOT NULL,
            last_record_id INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS tbl_fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            level INTEGER NOT NULL,
            parent_field_id INTEGER,
            UNIQUE(name, parent_field_id)
          );
          CREATE TABLE IF NOT EXISTS blobs.tbl_blobs (
            id INTEGER PRIMARY KEY,
            blob BLOB,
            object_id INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS blobs.idx_blobs_object_id
            ON tbl_blobs (object_id);
          CREATE TABLE IF NOT EXISTS tbl_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS tbl_index_observations (
            field_id INTEGER PRIMARY KEY,
            query_count INTEGER NOT NULL DEFAULT 0,
            equality_count INTEGER NOT NULL DEFAULT 0,
            range_count INTEGER NOT NULL DEFAULT 0,
            order_count INTEGER NOT NULL DEFAULT 0,
            other_count INTEGER NOT NULL DEFAULT 0,
            total_duration_ms REAL NOT NULL DEFAULT 0,
            slow_query_count INTEGER NOT NULL DEFAULT 0,
            result_rows INTEGER NOT NULL DEFAULT 0,
            last_seen_at INTEGER NOT NULL,
            last_evaluated_at INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS tbl_auto_indexes (
            field_id INTEGER PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            reason TEXT NOT NULL,
            score REAL NOT NULL,
            query_count_at_creation INTEGER NOT NULL
          );
          `,
        )
        const records = /** @type {Array<{ collection: string }>} */ (await all(
          database,
          'SELECT collection FROM tbl_record WHERE lower(collection) = lower(?)',
          [this.collection],
        ))
        if (records.length > 1) {
          throw new Error(`Collection metadata contains names that differ only by casing: ${this.collection}`)
        }
        if (records.length === 1 && String(records[0].collection) !== this.collection) {
          await run(
            database,
            'UPDATE tbl_record SET collection = ? WHERE collection = ?',
            [this.collection, records[0].collection],
          )
        }
        const roots = /** @type {Array<{ id: number, name: string }>} */ (await all(
          database,
          'SELECT id, name FROM tbl_fields WHERE parent_field_id IS NULL AND lower(name) = lower(?)',
          [this.collection],
        ))
        if (roots.length > 1) {
          throw new Error(`Collection fields contain root names that differ only by casing: ${this.collection}`)
        }
        if (roots.length === 1 && String(roots[0].name) !== this.collection) {
          await run(
            database,
            'UPDATE tbl_fields SET name = ? WHERE id = ?',
            [this.collection, roots[0].id],
          )
        }
        const storedPolicy = await get(
          database,
          'SELECT value FROM tbl_settings WHERE key = ?',
          [fieldIndexesSetting],
        )
        this.activeFieldIndexes =
          storedPolicy && typeof storedPolicy.value === 'string' && !this.fieldIndexesProvided
            ? deserializeFieldIndexes(storedPolicy.value)
            : this.requestedFieldIndexes
        if (!storedPolicy || this.fieldIndexesProvided) {
          await run(
            database,
            `INSERT INTO tbl_settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
            [fieldIndexesSetting, this.activeFieldIndexes.serialized],
          )
        }
        await this.refreshFields()
        const managedRows = await all(database, 'SELECT field_id FROM tbl_auto_indexes')
        const managedFieldIds = new Set(managedRows.map((row) => Number(row.field_id)))
        for (const field of this.fields) {
          const decision = this.activeFieldIndexes.decision(this.collection, field.path)
          const enabled = decision === 'enabled' ||
            (decision === 'auto' && managedFieldIds.has(field.id))
          await exec(
            database,
            valueTableSchema(field.id, enabled),
          )
        }
        if (this.activeFieldIndexes.mode !== 'auto') {
          await exec(database, 'DELETE FROM tbl_auto_indexes')
        } else {
          for (const field of this.fields) {
            if (this.activeFieldIndexes.decision(this.collection, field.path) !== 'auto') {
              await run(database, 'DELETE FROM tbl_auto_indexes WHERE field_id = ?', [field.id])
            }
          }
        }
        if (lockedVersion < schemaVersion) {
          await exec(database, `PRAGMA main.user_version=${schemaVersion}`)
        }
      })
      await this.refreshAutoIndexDiagnostics()
      await this.runPragmaOptimize({ initial: true }).catch((error) => {
        this.lastAutoIndexError = error
      })
      return this
    } catch (error) {
      await closeDatabase(database).catch(() => {})
      this.database = null
      throw error
    }
  }

  get db() {
    if (!this.database || this.closed || this.closing) throw new Error('IDB collection is closed')
    return this.database
  }

  async validateReadOnlySchema() {
    const mainTables = new Set(
      (await all(
        this.db,
        `SELECT name FROM main.sqlite_master
          WHERE type='table' AND name IN (
            'tbl_record', 'tbl_fields', 'tbl_settings',
            'tbl_index_observations', 'tbl_auto_indexes'
          )`,
      )).map((row) => String(row.name)),
    )
    const blobTables = new Set(
      (await all(
        this.db,
        `SELECT name FROM blobs.sqlite_master
          WHERE type='table' AND name='tbl_blobs'`,
      )).map((row) => String(row.name)),
    )
    const missingCore = [
      'tbl_record',
      'tbl_fields',
      'tbl_settings',
      'tbl_index_observations',
      'tbl_auto_indexes',
    ]
      .filter((name) => !mainTables.has(name))
    if (!blobTables.has('tbl_blobs')) missingCore.push('blobs.tbl_blobs')
    if (missingCore.length) {
      throw new Error(
        `Read-only collection ${this.collection} is missing required schema: ${missingCore.join(', ')}`,
      )
    }

    const columnChecks = [
      ['tbl_record', ['collection', 'last_record_id']],
      ['tbl_fields', ['id', 'name', 'level', 'parent_field_id']],
      ['tbl_settings', ['key', 'value']],
      ['blobs.tbl_blobs', ['id', 'blob', 'object_id']],
    ]
    for (const [table, requiredColumns] of columnChecks) {
      const pragma = table.startsWith('blobs.')
        ? `PRAGMA blobs.table_info('${table.slice(6)}')`
        : `PRAGMA main.table_info('${table}')`
      const columns = new Set((await all(this.db, pragma)).map((row) => String(row.name)))
      const missing = requiredColumns.filter((name) => !columns.has(name))
      if (missing.length) {
        throw new Error(
          `Read-only collection ${this.collection} has an incompatible ${table} table; missing columns: ${missing.join(', ')}`,
        )
      }
    }

    const setting = await get(
      this.db,
      'SELECT value FROM tbl_settings WHERE key = ?',
      [fieldIndexesSetting],
    )
    if (!setting || typeof setting.value !== 'string') {
      throw new Error(`Read-only collection ${this.collection} is missing its field-index policy`)
    }
    this.activeFieldIndexes = deserializeFieldIndexes(setting.value)
    await this.refreshFields()
    await this.refreshAutoIndexDiagnostics()

    const valueTables = new Set(
      (await all(
        this.db,
        `SELECT name FROM main.sqlite_master
          WHERE type='table' AND name LIKE 'tbl_values_%'`,
      )).map((row) => String(row.name)),
    )
    const missingValues = this.fields
      .map((field) => valueTable(field.id))
      .filter((name) => !valueTables.has(name))
    if (missingValues.length) {
      throw new Error(
        `Read-only collection ${this.collection} is missing value tables: ${missingValues.join(', ')}`,
      )
    }
  }

  async refreshFields() {
    const rows = await all(
      this.db,
      'SELECT id, name, level, parent_field_id FROM tbl_fields ORDER BY level, id',
    )
    const byId = new Map()
    /** @type {Field[]} */
    const fields = []
    for (const source of rows) {
      const id = Number(source.id)
      const parentId = source.parent_field_id == null ? null : Number(source.parent_field_id)
      const parent = parentId == null ? null : byId.get(parentId)
      const field = {
        id,
        name: String(source.name),
        level: Number(source.level),
        parent_field_id: parentId,
        path: parent && parent.parent_field_id !== null
          ? `${parent.path}.${String(source.name)}`
          : parent
            ? String(source.name)
            : '',
      }
      fields.push(field)
      byId.set(id, field)
    }
    this.fields = fields
    this.fieldsById = byId
  }

  /** @returns {Field | undefined} */
  get rootField() {
    return this.fields.find(
      (field) => field.parent_field_id === null &&
        field.name.toLowerCase() === this.collection.toLowerCase(),
    )
  }

  /**
   * @param {string} name
   * @param {number | null} parentFieldId
   * @param {number} level
   */
  async ensureField(name, parentFieldId, level) {
    let field = this.fields.find(
      (candidate) => candidate.name === name && candidate.parent_field_id === parentFieldId,
    )
    if (field) return field

    // NULL does not participate in SQLite UNIQUE constraints, so roots need an
    // explicit lookup before insertion.
    const result = await run(
      this.db,
      'INSERT INTO tbl_fields (name, level, parent_field_id) VALUES (?, ?, ?)',
      [name, level, parentFieldId],
    )
    const parent = parentFieldId == null ? null : this.fieldsById.get(parentFieldId)
    field = {
      id: result.lastID,
      name,
      level,
      parent_field_id: parentFieldId,
      path: parent && parent.parent_field_id !== null ? `${parent.path}.${name}` : parent ? name : '',
    }
    this.fields.push(field)
    this.fieldsById.set(field.id, field)
    await exec(
      this.db,
      valueTableSchema(
        field.id,
        this.activeFieldIndexes.isIndexed(this.collection, field.path),
      ),
    )
    return field
  }

  async refreshFieldIndexes() {
    const setting = await get(
      this.db,
      'SELECT value FROM tbl_settings WHERE key = ?',
      [fieldIndexesSetting],
    )
    if (!setting || typeof setting.value !== 'string') {
      throw new Error(`Collection ${this.collection} is missing its field-index policy`)
    }
    if (setting.value !== this.activeFieldIndexes.serialized) {
      this.activeFieldIndexes = deserializeFieldIndexes(setting.value)
    }
  }

  /**
   * Serializes writes within this process. BEGIN IMMEDIATE and busy_timeout
   * provide the corresponding cross-process safety.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  enqueueWrite(operation, options = {}) {
    const guarded = () => withDatabaseInterrupt(this.db, options.signal, operation)
    const next = this.writeQueue.then(guarded, guarded)
    this.writeQueue = next.catch(() => {})
    return next
  }

  /**
   * Runs a complete read/modify/write operation under one cross-process write
   * lock. Refreshing the catalog after BEGIN IMMEDIATE prevents stale field
   * metadata when another process has added fields.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  mutate(operation, options = {}) {
    if (this.mode === 'readonly') {
      return Promise.reject(new Error('IDB engine is read-only'))
    }
    return this.enqueueWrite(() =>
      transaction(this.db, async () => {
        await this.refreshFields()
        await this.refreshFieldIndexes()
        return operation()
      }), options,
    )
  }

  /**
   * Keeps multi-query document reads on a single SQLite snapshot and prevents
   * a local writer from interleaving transaction statements on this connection.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  snapshot(operation, options = {}) {
    return this.enqueueWrite(async () => {
      await exec(this.db, 'BEGIN')
      try {
        await this.refreshFields()
        const result = await operation()
        await exec(this.db, 'COMMIT')
        return result
      } catch (error) {
        try {
          await exec(this.db, 'ROLLBACK')
        } catch {
          // Preserve the read error if SQLite already ended the transaction.
        }
        throw error
      }
    }, options)
  }

  /**
   * @param {unknown[]} documents
   * @param {(number | null)[]} [existingObjectIds]
   */
  async writeDocuments(documents, existingObjectIds = documents.map(() => null), options = {}) {
    if (documents.length !== existingObjectIds.length) {
      throw new Error('Document and object id counts must match')
    }
    if (!documents.length) return []

    const encoded = await Promise.all(
      documents.map((document) => encodeDocument(document, this.collection)),
    )

    return this.mutate(() => this.writeEncodedDocuments(encoded, existingObjectIds), options)
  }

  /**
   * Replaces documents while the caller already owns `mutate()`'s transaction.
   * @param {unknown[]} documents
   * @param {(number | null)[]} [existingObjectIds]
   */
  async writeDocumentsInTransaction(
    documents,
    existingObjectIds = documents.map(() => null),
  ) {
    if (documents.length !== existingObjectIds.length) {
      throw new Error('Document and object id counts must match')
    }
    if (!documents.length) return []
    const encoded = await Promise.all(
      documents.map((document) => encodeDocument(document, this.collection)),
    )
    return this.writeEncodedDocuments(encoded, existingObjectIds)
  }

  /**
   * Transaction-internal write implementation.
   * @param {import('./codec.js').EncodedNode[][]} encoded
   * @param {(number | null)[]} existingObjectIds
   */
  async writeEncodedDocuments(encoded, existingObjectIds) {
        const record = await get(
          this.db,
          'SELECT last_record_id FROM tbl_record WHERE collection = ?',
          [this.collection],
        )
        let lastId = Number(record?.last_record_id || 0)

        const replacedIds = existingObjectIds.filter((id) => id != null)
        if (replacedIds.length) await this.deleteRows(replacedIds)

        /** @type {Array<{ fieldId: number, id: number, type: number, number: unknown, string: unknown, parentId: number | null, objectId: number }>} */
        const values = []
        /** @type {Array<{ id: number, blob: unknown, objectId: number }>} */
        const blobs = []
        /** @type {number[]} */
        const objectIds = []

        for (let documentIndex = 0; documentIndex < encoded.length; documentIndex++) {
          const nodes = encoded[documentIndex]
          const existingId = existingObjectIds[documentIndex]
          /** @type {number[]} */
          const rowIds = []
          /** @type {number[]} */
          const fieldIds = []

          for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index]
            const parentFieldId = node.parentIndex == null ? null : fieldIds[node.parentIndex]
            const field = await this.ensureField(node.key, parentFieldId, node.level)
            fieldIds[index] = field.id
            rowIds[index] = index === 0 && existingId != null ? existingId : ++lastId
          }

          const objectId = rowIds[0]
          objectIds.push(objectId)
          for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index]
            const rowId = rowIds[index]
            const parentId = node.parentIndex == null ? null : rowIds[node.parentIndex]
            let numberValue = null
            let stringValue = null
            if (node.type === ValueType.true || node.type === ValueType.false ||
                node.type === ValueType.number || node.type === ValueType.date ||
                node.type === ValueType.object) {
              numberValue = node.type === ValueType.object ? node.childCount : node.value
            } else if (node.type === ValueType.bigint || node.type === ValueType.string) {
              stringValue = node.value
            }
            values.push({
              fieldId: fieldIds[index],
              id: rowId,
              type: node.type,
              number: numberValue,
              string: stringValue,
              parentId,
              objectId,
            })
            if (node.type === ValueType.text || node.type === ValueType.array ||
                node.type === ValueType.binary) {
              blobs.push({ id: rowId, blob: node.value, objectId })
            }
          }
        }

        await run(
          this.db,
          `INSERT INTO tbl_record (collection, last_record_id) VALUES (?, ?)
           ON CONFLICT(collection) DO UPDATE SET last_record_id=excluded.last_record_id`,
          [this.collection, lastId],
        )

        /** @type {Map<number, typeof values>} */
        const grouped = new Map()
        for (const value of values) {
          const group = grouped.get(value.fieldId) || []
          group.push(value)
          grouped.set(value.fieldId, group)
        }
        for (const [fieldId, fieldValues] of grouped) {
          for (const batch of chunks(fieldValues, 300)) {
            await run(
              this.db,
              `INSERT INTO ${valueTable(fieldId)}
                (id, type, number, string, parent_id, object_id) VALUES ${batch
                  .map(() => '(?, ?, ?, ?, ?, ?)')
                  .join(', ')}`,
              batch.flatMap((value) => [
                value.id,
                value.type,
                value.number,
                value.string,
                value.parentId,
                value.objectId,
              ]),
            )
          }
        }

        for (const batch of chunks(blobs, 300)) {
          await run(
            this.db,
            `INSERT INTO blobs.tbl_blobs (id, blob, object_id) VALUES ${batch
              .map(() => '(?, ?, ?)')
              .join(', ')}`,
            batch.flatMap((blob) => [blob.id, blob.blob, blob.objectId]),
          )
        }
        return objectIds
  }

  /**
   * Internal transaction-aware deletion.
   * @param {number[]} objectIds
   */
  async deleteRows(objectIds) {
    if (!objectIds.length) return
    for (const batch of chunks(objectIds, 500)) {
      const placeholders = batch.map(() => '?').join(', ')
      for (const field of this.fields) {
        await run(
          this.db,
          `DELETE FROM ${valueTable(field.id)} WHERE object_id IN (${placeholders})`,
          batch,
        )
      }
      await run(
        this.db,
        `DELETE FROM blobs.tbl_blobs WHERE object_id IN (${placeholders})`,
        batch,
      )
    }
  }

  /** @param {number[]} objectIds */
  deleteObjects(objectIds, options = {}) {
    if (!objectIds.length) return Promise.resolve([])
    return this.mutate(() => this.deleteObjectsInTransaction(objectIds), options)
  }

  /** @param {number[]} objectIds */
  async deleteObjectsInTransaction(objectIds) {
    await this.deleteRows(objectIds)
    return objectIds.map((object_id) => ({ object_id }))
  }

  /**
   * @param {number[]} objectIds
   * @returns {Promise<Map<number, unknown>>}
   */
  async readDocuments(objectIds) {
    if (!objectIds.length || !this.rootField) return new Map()
    const requested = new Set(objectIds)
    /** @type {Array<Record<string, unknown>>} */
    const rows = []

    for (const objectBatch of chunks(objectIds, 400)) {
      const requested = objectBatch.map(() => '(?)').join(', ')
      for (const fieldBatch of chunks(this.fields, 350)) {
        const unions = fieldBatch.map(
          (field) => `SELECT ${field.id} AS field_id, v.id, v.type, v.number, v.string,
            v.parent_id, v.object_id, b.blob
            FROM ${valueTable(field.id)} v
            JOIN requested r ON r.object_id=v.object_id
            LEFT JOIN blobs.tbl_blobs b ON b.id=v.id`,
        )
        rows.push(...(await all(
          this.db,
          `WITH requested(object_id) AS (VALUES ${requested}) ${unions.join(' UNION ALL ')}`,
          objectBatch,
        )))
      }
    }

    rows.sort((left, right) => {
      const leftField = this.fieldsById.get(Number(left.field_id))
      const rightField = this.fieldsById.get(Number(right.field_id))
      return Number(left.object_id) - Number(right.object_id) ||
        Number(leftField?.level || 0) - Number(rightField?.level || 0) ||
        Number(left.id) - Number(right.id)
    })

    /** @type {Map<number, unknown>} */
    const documents = new Map()
    /** @type {Map<number, Map<number, unknown>>} */
    const targets = new Map()
    for (const row of rows) {
      const objectId = Number(row.object_id)
      if (!requested.has(objectId)) continue
      const field = this.fieldsById.get(Number(row.field_id))
      if (!field) continue
      const value = decodeValue(
        Number(row.type),
        row.number,
        row.string,
        row.blob,
      )
      if (field.parent_field_id === null) {
        documents.set(objectId, value)
        targets.set(objectId, new Map([[Number(row.id), value]]))
        continue
      }
      const objectTargets = targets.get(objectId)
      const parent = objectTargets?.get(Number(row.parent_id))
      if (!objectTargets || !parent || typeof parent !== 'object') continue
      Object.defineProperty(parent, field.name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
      objectTargets.set(Number(row.id), value)
    }

    return new Map(objectIds.filter((id) => documents.has(id)).map((id) => [id, documents.get(id)]))
  }

  /**
   * Reconstructs only the requested field subtrees. This is intentionally
   * separate from readDocuments() so complete-document reads and mutations
   * retain their established storage path.
   *
   * @param {number[]} objectIds
   * @param {number[]} fieldIds
   * @returns {Promise<Map<number, Map<number, unknown>>>}
   */
  async readSubtrees(objectIds, fieldIds) {
    const uniqueObjectIds = [...new Set(objectIds)]
    const uniqueFieldIds = [...new Set(fieldIds)]
    /** @type {Map<number, Map<number, unknown>>} */
    const result = new Map(uniqueFieldIds.map((fieldId) => [fieldId, new Map()]))
    if (!uniqueObjectIds.length || !uniqueFieldIds.length) return result

    for (const objectId of uniqueObjectIds) {
      if (!Number.isSafeInteger(objectId) || objectId < 1) {
        throw new Error('Invalid internal object id')
      }
    }

    for (const rootFieldId of uniqueFieldIds) {
      const rootField = this.fieldsById.get(rootFieldId)
      if (!rootField || rootField.parent_field_id === null) {
        throw new Error(`Invalid projected field id: ${rootFieldId}`)
      }

      const included = new Set([rootFieldId])
      for (const field of this.fields) {
        if (field.parent_field_id !== null && included.has(field.parent_field_id)) {
          included.add(field.id)
        }
      }
      const subtreeFields = this.fields.filter((field) => included.has(field.id))
      /** @type {Array<Record<string, unknown>>} */
      const rows = []

      for (const objectBatch of chunks(uniqueObjectIds, 400)) {
        const requested = objectBatch.map(() => '(?)').join(', ')
        for (const fieldBatch of chunks(subtreeFields, 350)) {
          const unions = fieldBatch.map(
            (field) => `SELECT ${field.id} AS field_id, v.id, v.type, v.number, v.string,
              v.parent_id, v.object_id, b.blob
              FROM ${valueTable(field.id)} v
              JOIN requested r ON r.object_id=v.object_id
              LEFT JOIN blobs.tbl_blobs b ON b.id=v.id AND b.object_id=v.object_id`,
          )
          rows.push(...(await all(
            this.db,
            `WITH requested(object_id) AS (VALUES ${requested}) ${unions.join(' UNION ALL ')}`,
            objectBatch,
          )))
        }
      }

      rows.sort((left, right) => {
        const leftField = this.fieldsById.get(Number(left.field_id))
        const rightField = this.fieldsById.get(Number(right.field_id))
        return Number(left.object_id) - Number(right.object_id) ||
          Number(leftField?.level || 0) - Number(rightField?.level || 0) ||
          Number(left.id) - Number(right.id)
      })

      const projected = result.get(rootFieldId)
      if (!projected) continue
      /** @type {Map<number, Map<string, { value: unknown, type: number }>>} */
      const targets = new Map()
      for (const row of rows) {
        const objectId = Number(row.object_id)
        const field = this.fieldsById.get(Number(row.field_id))
        if (!field) continue
        const type = Number(row.type)
        if (!validValueTypes.has(type)) {
          throw new Error(`IDB integrity error: unknown stored type ${type}`)
        }
        const value = decodeValue(type, row.number, row.string, row.blob)
        let objectTargets = targets.get(objectId)
        if (!objectTargets) {
          objectTargets = new Map()
          targets.set(objectId, objectTargets)
        }
        const nodeKey = `${field.id}:${Number(row.id)}`

        if (field.id === rootFieldId) {
          if (projected.has(objectId)) {
            throw new Error(
              `IDB integrity error: duplicate projected field ${rootField.path} for object ${objectId}`,
            )
          }
          projected.set(objectId, value)
          objectTargets.set(nodeKey, { value, type })
          continue
        }

        const parentFieldId = field.parent_field_id
        const parentKey = `${parentFieldId}:${Number(row.parent_id)}`
        const parent = objectTargets.get(parentKey)
        if (!parent) {
          throw new Error(
            `IDB integrity error: missing parent for projected field ${field.path}`,
          )
        }
        if (parent.type !== ValueType.object || !parent.value || typeof parent.value !== 'object') {
          throw new Error(
            `IDB integrity error: non-object parent for projected field ${field.path}`,
          )
        }
        Object.defineProperty(parent.value, field.name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
        objectTargets.set(nodeKey, { value, type })
      }
    }

    return result
  }

  /**
   * Builds the one-row-per-document dataset used by the SQL compiler.
   * @param {Field[]} requiredFields
   */
  datasetCte(requiredFields) {
    const root = this.rootField
    if (!root) return `SELECT CAST(NULL AS INTEGER) AS object_id WHERE 0`
    const projections = requiredFields.flatMap((field) => [
      `(SELECT ${valueExpression} FROM ${valueTable(field.id)} v
        WHERE v.object_id=root.object_id ORDER BY v.id LIMIT 1) AS "__f_${field.id}"`,
      `(SELECT v.type FROM ${valueTable(field.id)} v
        WHERE v.object_id=root.object_id ORDER BY v.id LIMIT 1) AS "__t_${field.id}"`,
    ])
    return `SELECT root.object_id${projections.length ? `, ${projections.join(', ')}` : ''}
      FROM ${valueTable(root.id)} root`
  }

  /** @param {string} sql @param {unknown[] | Record<string, unknown>} [parameters] */
  rawAll(sql, parameters = []) {
    return all(this.db, sql, parameters)
  }

  /**
   * Records only canonical field identities and aggregate timings. Query
   * values, SQL text, aliases, and document contents are never retained.
   * @param {readonly { fieldId: number, path: string, kind: string }[]} usage
   * @param {{ durationMs: number, resultRows: number }} metrics
   */
  recordQueryObservation(usage, metrics) {
    if (this.mode === 'readonly' || this.closed || this.closing) return
    const now = Date.now()
    if (this.activeFieldIndexes.mode !== 'auto') {
      if (now - this.lastOptimizeAt >= 24 * 60 * 60 * 1_000) {
        this.scheduleAutoIndexFlush()
      }
      return
    }
    const byField = new Map()
    for (const entry of usage) {
      let field = byField.get(entry.fieldId)
      if (!field) {
        field = { fieldId: entry.fieldId, path: entry.path, kinds: new Set() }
        byField.set(entry.fieldId, field)
      }
      field.kinds.add(entry.kind)
    }
    if (!byField.size) return
    this.pendingObservationQueries++
    for (const field of byField.values()) {
      let pending = this.pendingIndexObservations.get(field.fieldId)
      if (!pending) {
        pending = {
          fieldId: field.fieldId,
          path: field.path,
          kinds: new Set(),
          kindCounts: { equality: 0, range: 0, order: 0, other: 0 },
          queryCount: 0,
          totalDurationMs: 0,
          slowQueryCount: 0,
          resultRows: 0,
          lastSeenAt: now,
        }
        this.pendingIndexObservations.set(field.fieldId, pending)
      }
      for (const kind of field.kinds) {
        pending.kinds.add(kind)
        pending.kindCounts[kind] = (pending.kindCounts[kind] || 0) + 1
      }
      pending.queryCount++
      pending.totalDurationMs += Math.max(0, Number(metrics.durationMs) || 0)
      pending.slowQueryCount += metrics.durationMs >= this.activeFieldIndexes.auto.slowQueryMs ? 1 : 0
      pending.resultRows += Math.max(0, Number(metrics.resultRows) || 0)
      pending.lastSeenAt = now
    }
    this.scheduleAutoIndexFlush()
  }

  scheduleAutoIndexFlush() {
    if (this.autoIndexFlushTimer || this.closed || this.closing) return
    this.autoIndexFlushTimer = setTimeout(() => {
      this.autoIndexFlushTimer = null
      this.autoIndexFlushPromise = this.flushAutoIndexing({ evaluate: true })
        .catch((error) => {
          this.lastAutoIndexError = error
        })
        .finally(() => {
          this.autoIndexFlushPromise = null
        })
    }, 250)
    this.autoIndexFlushTimer.unref?.()
  }

  takePendingIndexObservations() {
    const observations = [...this.pendingIndexObservations.values()].map((entry) => ({
      ...entry,
      kinds: new Set(entry.kinds),
      kindCounts: { ...entry.kindCounts },
    }))
    const queries = this.pendingObservationQueries
    this.pendingIndexObservations.clear()
    this.pendingObservationQueries = 0
    return { observations, queries }
  }

  /** @param {{ observations: any[], queries: number }} batch */
  restorePendingIndexObservations(batch) {
    this.pendingObservationQueries += batch.queries
    for (const source of batch.observations) {
      let target = this.pendingIndexObservations.get(source.fieldId)
      if (!target) {
        target = { ...source, kinds: new Set(source.kinds), kindCounts: { ...source.kindCounts } }
        this.pendingIndexObservations.set(source.fieldId, target)
        continue
      }
      for (const kind of source.kinds) target.kinds.add(kind)
      for (const [kind, count] of Object.entries(source.kindCounts)) {
        target.kindCounts[kind] = (target.kindCounts[kind] || 0) + count
      }
      target.queryCount += source.queryCount
      target.totalDurationMs += source.totalDurationMs
      target.slowQueryCount += source.slowQueryCount
      target.resultRows += source.resultRows
      target.lastSeenAt = Math.max(target.lastSeenAt, source.lastSeenAt)
    }
  }

  /** @param {string} key */
  async numericSetting(key) {
    const row = await get(this.db, 'SELECT value FROM tbl_settings WHERE key = ?', [key])
    const value = Number(row?.value || 0)
    return Number.isFinite(value) ? value : 0
  }

  /** @param {string} key @param {number} value */
  setNumericSetting(key, value) {
    return run(
      this.db,
      `INSERT INTO tbl_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, String(value)],
    )
  }

  async buildAutoIndexPlan() {
    if (this.activeFieldIndexes.mode !== 'auto') {
      return {
        mode: 'manual',
        documents: 0,
        observedQueries: 0,
        managedIndexes: [],
        candidates: [],
        action: null,
      }
    }
    const configuration = this.activeFieldIndexes.auto
    const root = this.rootField
    const documentRow = root
      ? await get(this.db, `SELECT COUNT(*) AS count FROM ${valueTable(root.id)}`)
      : null
    const documents = Number(documentRow?.count || 0)
    const observations = await all(
      this.db,
      `SELECT o.*, f.name, f.parent_field_id
         FROM tbl_index_observations o
         JOIN tbl_fields f ON f.id=o.field_id
        ORDER BY o.field_id`,
    )
    const managedRows = await all(
      this.db,
      `SELECT a.*, f.name, f.parent_field_id
         FROM tbl_auto_indexes a
         JOIN tbl_fields f ON f.id=a.field_id
        ORDER BY a.field_id`,
    )
    const managed = new Map(managedRows.map((row) => [Number(row.field_id), row]))
    const now = Date.now()
    const candidates = []
    let observedQueries = 0
    for (const row of observations) {
      const fieldId = Number(row.field_id)
      const field = this.fieldsById.get(fieldId)
      if (!field || !field.path) continue
      const queryCount = Number(row.query_count || 0)
      const equalityCount = Number(row.equality_count || 0)
      const rangeCount = Number(row.range_count || 0)
      const otherCount = Number(row.other_count || 0)
      const filterCount = equalityCount + rangeCount + otherCount
      const averageDurationMs = queryCount ? Number(row.total_duration_ms || 0) / queryCount : 0
      const averageResultRows = queryCount ? Number(row.result_rows || 0) / queryCount : 0
      const resultRatio = documents ? Math.min(1, averageResultRows / documents) : 1
      const selectivity = 1 - resultRatio
      const frequency = Math.min(1, filterCount / configuration.minQueryCount)
      const slowness = configuration.slowQueryMs === 0
        ? 1
        : Math.min(1, averageDurationMs / configuration.slowQueryMs)
      const equalityWeight = filterCount ? equalityCount / filterCount : 0
      const score = Number((frequency * 0.45 + selectivity * 0.35 + slowness * 0.15 + equalityWeight * 0.05).toFixed(4))
      const decision = this.activeFieldIndexes.decision(this.collection, field.path)
      const managedRow = managed.get(fieldId)
      const eligible = decision === 'auto' && !managedRow &&
        documents >= configuration.minDocuments &&
        filterCount >= configuration.minQueryCount &&
        resultRatio <= configuration.maxResultRatio
      observedQueries = Math.max(observedQueries, queryCount)
      candidates.push(Object.freeze({
        fieldId,
        path: field.path,
        state: decision === 'enabled'
          ? 'pinned-enabled'
          : decision === 'disabled'
            ? 'pinned-disabled'
            : managedRow
              ? 'managed'
              : eligible ? 'candidate' : 'observing',
        score,
        queryCount,
        equalityCount,
        rangeCount,
        orderCount: Number(row.order_count || 0),
        otherCount,
        averageDurationMs,
        averageResultRows,
        resultRatio,
        lastSeenAt: Number(row.last_seen_at || 0),
        eligible,
      }))
    }

    const managedIndexes = managedRows.map((row) => {
      const field = this.fieldsById.get(Number(row.field_id))
      return Object.freeze({
        fieldId: Number(row.field_id),
        path: field?.path || null,
        createdAt: Number(row.created_at),
        lastUsedAt: Number(row.last_used_at),
        reason: String(row.reason),
        score: Number(row.score),
      })
    })
    const lastChangeAt = await this.numericSetting('auto_index_last_change_at')
    const cooldownComplete = now - lastChangeAt >= configuration.cooldownMs
    let action = null
    const creatable = candidates
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))[0]
    if (
      cooldownComplete && creatable &&
      managedIndexes.length < configuration.maxIndexesPerCollection
    ) {
      action = Object.freeze({
        type: 'create',
        fieldId: creatable.fieldId,
        path: creatable.path,
        score: creatable.score,
        reason: `frequent selective filters (${creatable.queryCount} observations, ${(creatable.resultRatio * 100).toFixed(1)}% average result ratio)`,
      })
    } else if (cooldownComplete && configuration.allowDrop) {
      const removable = managedIndexes
        .filter((index) =>
          index.path &&
          this.activeFieldIndexes.decision(this.collection, index.path) === 'auto' &&
          now - index.createdAt >= configuration.minIndexAgeMs &&
          now - index.lastUsedAt >= configuration.dropUnusedAfterMs,
        )
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
      if (removable) {
        action = Object.freeze({
          type: 'drop',
          fieldId: removable.fieldId,
          path: removable.path,
          score: removable.score,
          reason: `unused for ${now - removable.lastUsedAt} ms`,
        })
      }
    }
    return {
      mode: 'auto',
      documents,
      observedQueries,
      managedIndexes,
      candidates: candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)),
      action,
      lastChangeAt: lastChangeAt || null,
    }
  }

  /** @param {{ apply: boolean }} options */
  async evaluateAutoIndexesInTransaction(options) {
    const plan = await this.buildAutoIndexPlan()
    let changed = null
    if (options.apply && plan.action) {
      const field = this.fieldsById.get(plan.action.fieldId)
      if (field && field.path === plan.action.path) {
        const now = Date.now()
        if (plan.action.type === 'create') {
          await exec(this.db, valueTableSchema(field.id, true))
          const observation = await get(
            this.db,
            'SELECT query_count FROM tbl_index_observations WHERE field_id = ?',
            [field.id],
          )
          await run(
            this.db,
            `INSERT INTO tbl_auto_indexes
              (field_id, created_at, last_used_at, reason, score, query_count_at_creation)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              field.id,
              now,
              now,
              plan.action.reason,
              plan.action.score,
              Number(observation?.query_count || 0),
            ],
          )
        } else {
          await exec(this.db, valueTableSchema(field.id, false))
          await run(this.db, 'DELETE FROM tbl_auto_indexes WHERE field_id = ?', [field.id])
          await run(this.db, 'DELETE FROM tbl_index_observations WHERE field_id = ?', [field.id])
        }
        await this.setNumericSetting('auto_index_last_change_at', now)
        changed = plan.action
      }
    }
    if (options.apply) {
      const now = Date.now()
      await this.setNumericSetting('auto_index_last_evaluation_at', now)
      await exec(this.db, `UPDATE tbl_index_observations SET last_evaluated_at=${now}`)
      // Exponential decay keeps telemetry bounded and lets old workloads lose
      // influence without retaining an unbounded query log.
      await exec(
        this.db,
        `UPDATE tbl_index_observations SET
           query_count=CAST(query_count * 0.9 AS INTEGER),
           equality_count=CAST(equality_count * 0.9 AS INTEGER),
           range_count=CAST(range_count * 0.9 AS INTEGER),
           order_count=CAST(order_count * 0.9 AS INTEGER),
           other_count=CAST(other_count * 0.9 AS INTEGER),
           total_duration_ms=total_duration_ms * 0.9,
           slow_query_count=CAST(slow_query_count * 0.9 AS INTEGER),
           result_rows=CAST(result_rows * 0.9 AS INTEGER)`,
      )
      await this.setNumericSetting('auto_index_query_counter', 0)
      await this.setNumericSetting('auto_index_last_evaluation_query', 0)
    }
    return { ...plan, changed }
  }

  /** @param {{ evaluate?: boolean, signal?: AbortSignal }} [options] */
  async flushAutoIndexing(options = {}) {
    if (this.mode === 'readonly' || this.closed || this.closing) return null
    const batch = this.takePendingIndexObservations()
    const dueForPeriodicOptimize = Date.now() - this.lastOptimizeAt >= 24 * 60 * 60 * 1_000
    if (!batch.observations.length && !dueForPeriodicOptimize) return null
    let result
    try {
      result = await this.enqueueWrite(() => transaction(this.db, async () => {
        await this.refreshFieldIndexes()
        if (this.activeFieldIndexes.mode !== 'auto') return null
        for (const observation of batch.observations) {
          const counts = {
            equality: observation.kindCounts.equality || 0,
            range: observation.kindCounts.range || 0,
            order: observation.kindCounts.order || 0,
            other: observation.kindCounts.other || 0,
          }
          await run(
            this.db,
            `INSERT INTO tbl_index_observations
              (field_id, query_count, equality_count, range_count, order_count,
               other_count, total_duration_ms, slow_query_count, result_rows,
               last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(field_id) DO UPDATE SET
               query_count=query_count+excluded.query_count,
               equality_count=equality_count+excluded.equality_count,
               range_count=range_count+excluded.range_count,
               order_count=order_count+excluded.order_count,
               other_count=other_count+excluded.other_count,
               total_duration_ms=total_duration_ms+excluded.total_duration_ms,
               slow_query_count=slow_query_count+excluded.slow_query_count,
               result_rows=result_rows+excluded.result_rows,
               last_seen_at=MAX(last_seen_at, excluded.last_seen_at)`,
            [
              observation.fieldId,
              observation.queryCount,
              counts.equality,
              counts.range,
              counts.order,
              counts.other,
              observation.totalDurationMs,
              observation.slowQueryCount,
              observation.resultRows,
              observation.lastSeenAt,
            ],
          )
          if (counts.equality + counts.range + counts.other > 0) {
            await run(
              this.db,
              'UPDATE tbl_auto_indexes SET last_used_at=? WHERE field_id=?',
              [observation.lastSeenAt, observation.fieldId],
            )
          }
        }
        const queryCounter = await this.numericSetting('auto_index_query_counter') + batch.queries
        await this.setNumericSetting('auto_index_query_counter', queryCounter)
        const lastEvaluationQuery = await this.numericSetting('auto_index_last_evaluation_query')
        const evaluate = options.evaluate !== false &&
          queryCounter - lastEvaluationQuery >= this.activeFieldIndexes.auto.evaluationInterval
        return evaluate
          ? this.evaluateAutoIndexesInTransaction({ apply: true })
          : this.buildAutoIndexPlan()
      }), { signal: options.signal })
    } catch (error) {
      this.restorePendingIndexObservations(batch)
      throw error
    }
    await this.refreshAutoIndexDiagnostics()
    if (result?.changed || dueForPeriodicOptimize) {
      await this.enqueueWrite(() => this.runPragmaOptimize(), { signal: options.signal })
    }
    return result
  }

  /** @param {{ dryRun?: boolean, signal?: AbortSignal }} [options] */
  async optimizeIndexes(options = {}) {
    if (this.mode === 'readonly') throw new Error('IDB engine is read-only')
    await this.flushAutoIndexing({ evaluate: false, signal: options.signal })
    const result = await this.enqueueWrite(() => transaction(this.db, async () => {
      await this.refreshFieldIndexes()
      return this.evaluateAutoIndexesInTransaction({ apply: options.dryRun !== true })
    }), { signal: options.signal })
    await this.refreshAutoIndexDiagnostics(options.dryRun === true ? result : null)
    if (result.changed) {
      await this.enqueueWrite(() => this.runPragmaOptimize(), { signal: options.signal })
    }
    return Object.freeze({
      collection: this.collection,
      mode: result.mode,
      dryRun: options.dryRun === true,
      documents: result.documents,
      action: result.changed || result.action,
      changed: result.changed,
      candidates: Object.freeze(result.candidates),
      managedIndexes: Object.freeze(result.managedIndexes),
    })
  }

  async refreshAutoIndexDiagnostics(plan = null) {
    if (!this.database || this.closed || this.closing) return
    try {
      const current = plan || await this.buildAutoIndexPlan()
      const observedRow = await get(
        this.db,
        'SELECT COALESCE(SUM(query_count), 0) AS count FROM tbl_index_observations',
      )
      const lastEvaluationAt = await this.numericSetting('auto_index_last_evaluation_at')
      const lastChangeAt = await this.numericSetting('auto_index_last_change_at')
      this.autoIndexDiagnostics = Object.freeze({
        mode: this.activeFieldIndexes.mode,
        preset: this.activeFieldIndexes.auto?.preset || null,
        pendingQueries: this.pendingObservationQueries,
        observedQueries: Number(observedRow?.count || 0),
        managedIndexes: Object.freeze([...(current.managedIndexes || [])]),
        candidates: Object.freeze([...(current.candidates || [])]),
        proposedAction: current.action || null,
        lastEvaluationAt: lastEvaluationAt || null,
        lastChangeAt: lastChangeAt || null,
        lastError: this.lastAutoIndexError
          ? String(this.lastAutoIndexError.message || this.lastAutoIndexError)
          : null,
      })
    } catch (error) {
      this.lastAutoIndexError = error
    }
  }

  async runPragmaOptimize(options = {}) {
    if (this.mode === 'readonly') return
    await exec(this.db, options.initial ? 'PRAGMA optimize=0x10002' : 'PRAGMA optimize')
    this.lastOptimizeAt = Date.now()
  }

  diagnostics() {
    let fieldIndexes = this.activeFieldIndexes.serialized
    try {
      fieldIndexes = JSON.parse(fieldIndexes)
    } catch {
      // Keep the persisted representation visible if a future policy format is
      // not JSON-decodable by this version.
    }
    return Object.freeze({
      collection: this.collection,
      schemaVersion,
      mode: this.mode,
      fields: this.fields.length,
      fieldIndexes,
      databasePath: this.databasePath,
      blobPath: this.blobPath,
      autoIndexing: Object.freeze({
        ...this.autoIndexDiagnostics,
        pendingQueries: this.pendingObservationQueries,
        lastError: this.lastAutoIndexError
          ? String(this.lastAutoIndexError.message || this.lastAutoIndexError)
          : this.autoIndexDiagnostics.lastError,
      }),
    })
  }

  async storageStats(options = {}) {
    return this.snapshot(async () => {
      throwIfAborted(options.signal)
      const [mainPageCount, mainPageSize, mainFreePages, blobPageCount, blobPageSize, blobFreePages] =
        await Promise.all([
          get(this.db, 'PRAGMA main.page_count'),
          get(this.db, 'PRAGMA main.page_size'),
          get(this.db, 'PRAGMA main.freelist_count'),
          get(this.db, 'PRAGMA blobs.page_count'),
          get(this.db, 'PRAGMA blobs.page_size'),
          get(this.db, 'PRAGMA blobs.freelist_count'),
        ])
      const numberFrom = (row) => Number(Object.values(row || {})[0] || 0)
      const mainPages = numberFrom(mainPageCount)
      const mainBytesPerPage = numberFrom(mainPageSize)
      const mainFree = numberFrom(mainFreePages)
      const blobPages = numberFrom(blobPageCount)
      const blobBytesPerPage = numberFrom(blobPageSize)
      const blobFree = numberFrom(blobFreePages)
      const fileBytes = this.memory
        ? { collection: null, blobs: null }
        : {
            collection: (await stat(this.databasePath)).size,
            blobs: (await stat(this.blobPath)).size,
          }
      return Object.freeze({
        collection: this.collection,
        files: Object.freeze(fileBytes),
        main: Object.freeze({
          pageCount: mainPages,
          pageSize: mainBytesPerPage,
          freePages: mainFree,
          allocatedBytes: mainPages * mainBytesPerPage,
          reclaimableBytes: mainFree * mainBytesPerPage,
        }),
        blobs: Object.freeze({
          pageCount: blobPages,
          pageSize: blobBytesPerPage,
          freePages: blobFree,
          allocatedBytes: blobPages * blobBytesPerPage,
          reclaimableBytes: blobFree * blobBytesPerPage,
        }),
      })
    }, options)
  }

  /**
   * Returns an immutable observed structure for this collection or one exact
   * canonical field path. Arrays remain atomic values, matching query/storage
   * semantics; their internal elements are not promoted to collection fields.
   * @param {{path?: string, signal?: AbortSignal}} [options]
   */
  async structure(options = {}) {
    return this.snapshot(async () => {
      throwIfAborted(options.signal)
      const rootField = this.rootField
      if (!rootField) throw new Error(`Collection ${this.collection} has no root field metadata`)
      const target = options.path === undefined
        ? rootField
        : this.fields.find((field) => field.path === options.path)
      if (!target) {
        throw new Error(
          `Collection ${this.collection} does not contain field path: ${String(options.path)}`,
        )
      }

      const selectedIds = new Set([target.id])
      for (const field of this.fields) {
        if (field.parent_field_id !== null && selectedIds.has(field.parent_field_id)) {
          selectedIds.add(field.id)
        }
      }
      const selectedFields = this.fields.filter((field) => selectedIds.has(field.id))
      const statisticIds = new Set(selectedIds)
      statisticIds.add(rootField.id)
      if (target.parent_field_id !== null) statisticIds.add(target.parent_field_id)
      const statisticFields = this.fields.filter((field) => statisticIds.has(field.id))

      /** @type {Array<{field_id: number, type: number, value_count: number}>} */
      const typeRows = []
      for (const batch of chunks(statisticFields, 200)) {
        const statement = batch.map((field) =>
          `SELECT ${field.id} AS field_id, type, COUNT(*) AS value_count ` +
          `FROM ${valueTable(field.id)} GROUP BY type`,
        ).join(' UNION ALL ')
        if (statement) typeRows.push(...await all(this.db, statement))
      }

      /** @type {Map<number, Map<string, number>>} */
      const typeCountsByField = new Map()
      for (const row of typeRows) {
        const fieldId = Number(row.field_id)
        const logicalType = logicalValueTypes.get(Number(row.type))
        if (!logicalType) {
          throw new Error(
            `IDB integrity error: field ${fieldId} contains unsupported stored type ${row.type}`,
          )
        }
        const counts = typeCountsByField.get(fieldId) ?? new Map()
        counts.set(logicalType, (counts.get(logicalType) ?? 0) + Number(row.value_count || 0))
        typeCountsByField.set(fieldId, counts)
      }

      const indexRows = await all(
        this.db,
        `SELECT name FROM sqlite_master
          WHERE type='index' AND name LIKE 'idx_values_%_query_object'`,
      )
      const indexedFieldIds = new Set(indexRows
        .map((row) => /^idx_values_(\d+)_query_object$/.exec(String(row.name))?.[1])
        .filter(Boolean)
        .map(Number))
      const presentCount = (fieldId) => [...(typeCountsByField.get(fieldId)?.values() ?? [])]
        .reduce((total, count) => total + count, 0)
      const objectCount = (fieldId) => typeCountsByField.get(fieldId)?.get('object') ?? 0
      const documentCount = presentCount(rootField.id)

      const childrenByParent = new Map()
      for (const field of selectedFields) {
        if (field.parent_field_id === null) continue
        const siblings = childrenByParent.get(field.parent_field_id) ?? []
        siblings.push(field)
        childrenByParent.set(field.parent_field_id, siblings)
      }

      /** @param {Field} field */
      const buildNode = (field) => {
        const counts = typeCountsByField.get(field.id) ?? new Map()
        const presentInDocuments = presentCount(field.id)
        const parentObjectDocuments = field.parent_field_id === null
          ? documentCount
          : objectCount(field.parent_field_id)
        const types = Object.freeze([...counts.entries()]
          .map(([type, count]) => Object.freeze({ type, count }))
          .sort((left, right) => {
            const leftIndex = logicalValueTypeOrder.indexOf(left.type)
            const rightIndex = logicalValueTypeOrder.indexOf(right.type)
            return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex)
          }))
        const children = Object.freeze(
          (childrenByParent.get(field.id) ?? []).map((child) => buildNode(child)),
        )
        return Object.freeze({
          name: field.parent_field_id === null ? this.collection : field.name,
          path: field.path,
          depth: field.level,
          types,
          presentInDocuments,
          coverage: documentCount ? presentInDocuments / documentCount : 0,
          optional: field.parent_field_id !== null && presentInDocuments < documentCount,
          coverageWithinParent: field.parent_field_id === null
            ? (documentCount ? 1 : 0)
            : parentObjectDocuments ? presentInDocuments / parentObjectDocuments : 0,
          optionalWithinParent: field.parent_field_id !== null &&
            presentInDocuments < parentObjectDocuments,
          indexed: indexedFieldIds.has(field.id),
          children,
        })
      }

      return Object.freeze({
        collection: this.collection,
        path: options.path ?? null,
        documentCount,
        fieldCount: target === rootField ? Math.max(0, selectedFields.length - 1) : selectedFields.length,
        maxDepth: selectedFields.reduce((maximum, field) => Math.max(maximum, field.level), 0),
        root: buildNode(target),
      })
    }, options)
  }

  async maintenance(operation, options = {}) {
    if (this.mode === 'readonly') {
      throw new Error('IDB engine is read-only')
    }
    if (operation !== 'analyze' && operation !== 'vacuum') {
      throw new TypeError('maintenance operation must be "analyze" or "vacuum"')
    }
    const startedAt = performance.now()
    return this.enqueueWrite(async () => {
      throwIfAborted(options.signal)
      if (operation === 'analyze') {
        await exec(this.db, 'ANALYZE main; ANALYZE blobs;')
      } else {
        // VACUUM cannot run inside a transaction. The collection queue still
        // excludes local readers/writers, while SQLite coordinates processes.
        await exec(this.db, 'VACUUM main; VACUUM blobs;')
      }
      throwIfAborted(options.signal)
      return Object.freeze({
        collection: this.collection,
        operation,
        durationMs: performance.now() - startedAt,
      })
    }, options)
  }

  async close() {
    if (this.closed) return
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      await this.writeQueue.catch(() => {})
      if (!this.database) {
        this.closed = true
        return
      }
      if (this.autoIndexFlushTimer) {
        clearTimeout(this.autoIndexFlushTimer)
        this.autoIndexFlushTimer = null
      }
      await this.autoIndexFlushPromise?.catch(() => {})
      await this.flushAutoIndexing({ evaluate: true }).catch((error) => {
        this.lastAutoIndexError = error
      })
      await this.writeQueue.catch(() => {})
      await this.runPragmaOptimize().catch((error) => {
        this.lastAutoIndexError = error
      })
      this.closing = true
      try {
        await closeDatabase(this.database)
        this.database = null
        this.closed = true
      } catch (error) {
        this.closing = false
        this.closePromise = null
        throw error
      }
    })()
    return this.closePromise
  }
}

export { quoteSqlString }
