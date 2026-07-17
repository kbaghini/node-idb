// @ts-check

import fs from 'node:fs'
import path from 'node:path'

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

const schemaVersion = 3

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

/** @param {number} fieldId */
function valueTableSchema(fieldId) {
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
    CREATE INDEX IF NOT EXISTS idx_values_${fieldId}_query_object
      ON ${table} ((${indexedValueExpression()}), object_id);
    CREATE INDEX IF NOT EXISTS idx_values_${fieldId}_type_object
      ON ${table} (type, object_id);
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
   * @param {{ project: string, collection: string, storagePath: string, memory: boolean }} options
   */
  constructor({ project, collection, storagePath, memory }) {
    this.project = project
    this.collection = collection
    this.storagePath = storagePath
    this.memory = memory
    /** @type {import('sqlite3').Database | null} */
    this.database = null
    /** @type {Field[]} */
    this.fields = []
    /** @type {Map<number, Field>} */
    this.fieldsById = new Map()
    /** @type {Promise<unknown>} */
    this.writeQueue = Promise.resolve()
    this.closed = false
  }

  async initialize() {
    if (this.database) return this

    let databasePath = ':memory:'
    let blobPath = ':memory:'
    if (!this.memory) {
      const projectDirectory = path.join(this.storagePath, this.project)
      fs.mkdirSync(projectDirectory, { recursive: true })
      databasePath = path.join(projectDirectory, `db-collection-${this.collection}.sqlite`)
      blobPath = path.join(projectDirectory, `db-blobs-${this.collection}.sqlite`)
    }

    const database = await openDatabase(databasePath)
    this.database = database
    try {
      await run(database, 'ATTACH DATABASE ? AS blobs', [blobPath])
      await exec(
        database,
        `
          PRAGMA main.busy_timeout=10000;
          PRAGMA blobs.busy_timeout=10000;
          PRAGMA main.foreign_keys=ON;
          PRAGMA main.temp_store=MEMORY;
          PRAGMA main.cache_size=-16384;
          PRAGMA main.mmap_size=268435456;
          PRAGMA blobs.cache_size=-8192;
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
        `,
      )
      if (!this.memory) {
        await get(database, 'PRAGMA main.journal_mode=DELETE')
        await get(database, 'PRAGMA blobs.journal_mode=DELETE')
        await exec(
          database,
          `PRAGMA main.synchronous=FULL;
           PRAGMA blobs.synchronous=FULL;`,
        )
      }
      await this.refreshFields()
      for (const field of this.fields) await exec(database, valueTableSchema(field.id))
      await exec(database, `PRAGMA main.user_version=${schemaVersion}`)
      return this
    } catch (error) {
      await closeDatabase(database).catch(() => {})
      this.database = null
      throw error
    }
  }

  get db() {
    if (!this.database || this.closed) throw new Error('IDB collection is closed')
    return this.database
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
      (field) => field.parent_field_id === null && field.name === this.collection,
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
    await exec(this.db, valueTableSchema(field.id))
    return field
  }

  /**
   * Serializes writes within this process. BEGIN IMMEDIATE and busy_timeout
   * provide the corresponding cross-process safety.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation)
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
  mutate(operation) {
    return this.enqueueWrite(() =>
      transaction(this.db, async () => {
        await this.refreshFields()
        return operation()
      }),
    )
  }

  /**
   * Keeps multi-query document reads on a single SQLite snapshot and prevents
   * a local writer from interleaving transaction statements on this connection.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  snapshot(operation) {
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
    })
  }

  /**
   * @param {unknown[]} documents
   * @param {(number | null)[]} [existingObjectIds]
   */
  async writeDocuments(documents, existingObjectIds = documents.map(() => null)) {
    if (documents.length !== existingObjectIds.length) {
      throw new Error('Document and object id counts must match')
    }
    if (!documents.length) return []

    const encoded = await Promise.all(
      documents.map((document) => encodeDocument(document, this.collection)),
    )

    return this.mutate(() => this.writeEncodedDocuments(encoded, existingObjectIds))
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
  deleteObjects(objectIds) {
    if (!objectIds.length) return Promise.resolve([])
    return this.mutate(() => this.deleteObjectsInTransaction(objectIds))
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

  async close() {
    if (this.closed) return
    await this.writeQueue.catch(() => {})
    this.closed = true
    if (this.database) await closeDatabase(this.database)
    this.database = null
  }
}

export { quoteSqlString }
