// @ts-check

import path from 'node:path'

import { assertFieldName, deepClone, deepMerge, isPlainObject } from './codec.js'
import { CollectionStore } from './collection.js'
import {
  compileExpression,
  compileObjectIds,
  compileSelect,
  decodeSelectRows,
  parseSql,
} from './sql.js'

const identifierPattern = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|\[[^\]]+\]|[A-Za-z0-9_-]+)`

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

/** @param {string} value @param {string} label @param {boolean} [memory] */
function assertStorageName(value, label, memory = false) {
  if (typeof value !== 'string' || !value.length) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  const name = memory && value.startsWith('mem:') ? value.slice(4) : value
  if (
    !/^(?=.{1,128}$)(?=.*[A-Za-z0-9_])[A-Za-z0-9_-]+$/.test(name) ||
    name === '.' || name === '..'
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

/** @param {string} statement @param {string} keyword */
function collectionAfter(statement, keyword) {
  const match = new RegExp(`^\\s*${keyword}\\s+(?:into\\s+)?(${identifierPattern})`, 'i').exec(statement)
  if (!match) throw new Error(`A collection name is required after ${keyword.toUpperCase()}`)
  return cleanIdentifier(match[1])
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
 * @typedef {{ storagePath?: string }} IdbOptions
 */

/**
 * Creates an isolated IDB engine. The default export below uses cwd/idbs for
 * direct compatibility with the original deployment layout.
 * @param {IdbOptions} [options]
 */
export function createIdb({ storagePath = path.resolve('idbs') } = {}) {
  /** @type {Map<string, Promise<CollectionStore>>} */
  const stores = new Map()
  /** @type {Set<Promise<unknown>>} */
  const operations = new Set()

  /** @template T @param {() => Promise<T>} operation */
  function track(operation) {
    const promise = Promise.resolve().then(operation)
    operations.add(promise)
    promise.then(
      () => operations.delete(promise),
      () => operations.delete(promise),
    )
    return promise
  }

  /** @param {string} project @param {string} collection */
  async function getStore(project, collection) {
    assertStorageName(project, 'project', true)
    assertStorageName(collection, 'collection')
    const key = `${project}\0${collection}`
    let pending = stores.get(key)
    if (!pending) {
      const store = new CollectionStore({
        project,
        collection,
        storagePath,
        memory: project.startsWith('mem:'),
      })
      pending = store.initialize()
      stores.set(key, pending)
      pending.catch(() => stores.delete(key))
    }
    return pending
  }

  /** @param {CollectionStore} store @param {any} statement @param {unknown} parameters */
  async function selectObjectIds(store, statement, parameters) {
    const compiled = compileObjectIds(store, statement, parameters)
    return resultRowsToIds(await store.rawAll(compiled.sql, compiled.parameters))
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function insert(project, statement, parameters) {
    const collection = collectionAfter(statement, 'insert')
    const tail = statement.replace(
      new RegExp(`^\\s*insert\\s+(?:into\\s+)?${identifierPattern}\\s*;?\\s*$`, 'i'),
      '',
    )
    if (tail) throw new Error('INSERT accepts a collection and document payload only')
    const store = await getStore(project, collection)
    if (Array.isArray(parameters)) return store.writeDocuments(parameters)
    const [objectId] = await store.writeDocuments([parameters])
    return objectId
  }

  /**
   * @param {string} project
   * @param {string} statement
   * @param {unknown} parameters
   * @param {'update' | 'replace'} mode
   */
  async function upsert(project, statement, parameters, mode) {
    const prefix = mode === 'replace'
      ? /^\s*insert\s+or\s+replace\s+(?:into\s+)?/i
      : /^\s*(?:upsert|insert\s+or\s+update)\s+(?:into\s+)?/i
    const remainder = statement.replace(prefix, '')
    const collectionMatch = new RegExp(`^(${identifierPattern})([\\s\\S]*)$`, 'i').exec(remainder.trim())
    if (!collectionMatch) throw new Error('An upsert collection is required')
    const collection = cleanIdentifier(collectionMatch[1])
    const filter = collectionMatch[2].trim()
    const store = await getStore(project, collection)
    const selector = await parseSql(`SELECT object_id FROM ${collectionMatch[1]} ${filter}`)
    return store.mutate(async () => {
      const objectIds = await selectObjectIds(store, selector, parameters)

      if (!objectIds.length) {
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
    })
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function select(project, statement, parameters) {
    const collection = collectionAfterFrom(statement)
    const store = await getStore(project, collection)
    return store.snapshot(async () => {
      const compiled = await compileSelect(store, statement, parameters)
      const rows = await store.rawAll(compiled.sql, compiled.parameters)
      return decodeSelectRows(rows, compiled.metadata)
    })
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function getDocuments(project, statement, parameters) {
    const normalized = statement.replace(/^\s*(get|find|collect)\s+/i, 'SELECT object_id FROM ')
    const collection = collectionAfterFrom(normalized)
    const store = await getStore(project, collection)
    const parsed = await parseSql(normalized)
    return store.snapshot(async () => {
      const objectIds = await selectObjectIds(store, parsed, parameters)
      const documents = await store.readDocuments(objectIds)
      return objectIds.filter((id) => documents.has(id)).map((id) => documents.get(id))
    })
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function update(project, statement, parameters) {
    const collection = collectionAfter(statement, 'update')
    const store = await getStore(project, collection)
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
      return store.mutate(async () => {
        const objectIds = await selectObjectIds(store, parsed, parameters)
        if (!objectIds.length) return []
        const existing = await store.readDocuments(objectIds)
        const documents = objectIds.map((id) => deepMerge(existing.get(id), parameters))
        await store.writeDocumentsInTransaction(documents, objectIds)
        return objectIds.map((object_id) => ({ object_id }))
      })
    }

    const parsed = await parseSql(statement)
    if (parsed.variant !== 'update') throw new Error('Invalid UPDATE statement')
    return store.mutate(async () => {
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
    })
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function remove(project, statement, parameters) {
    const body = statement.replace(/^\s*delete\b/i, '').trimStart()
    const fromIndex = findOuterKeyword(body, 'from')
    if (fromIndex < 0) throw new Error('Invalid DELETE statement')
    const selection = body.slice(0, fromIndex).trim() || '*'
    const collectionSource = takeIdentifier(body.slice(fromIndex + 4))
    const collectionToken = collectionSource.token
    const filter = collectionSource.rest

    const collection = cleanIdentifier(collectionToken)
    const selectedIdentifiers = splitIdentifierList(selection)
    const store = await getStore(project, collection)
    const parsed = await parseSql(`SELECT object_id FROM ${collectionToken} ${filter}`)
    return store.mutate(async () => {
      const objectIds = await selectObjectIds(store, parsed, parameters)
      if (!objectIds.length) return []
      if (
        selection === '*' ||
        (selectedIdentifiers.length === 1 &&
          cleanIdentifier(selectedIdentifiers[0]).toLowerCase() === collection.toLowerCase())
      ) {
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
    })
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function rawQuery(project, statement, parameters) {
    const match = new RegExp(
      `^\\s*(?:query\\s+)?(?:on|in|over|with|use|using)\\s+(${identifierPattern})\\s+([\\s\\S]+)$`,
      'i',
    ).exec(statement)
    if (!match) throw new Error('Invalid raw query syntax')
    const collection = cleanIdentifier(match[1])
    const sql = match[2].trim()
    if (!/^\s*(select|explain)\b/i.test(sql)) {
      throw new Error('Raw queries are read-only; only SELECT or EXPLAIN is allowed')
    }
    const store = await getStore(project, collection)
    return store.snapshot(() => store.rawAll(
      sql,
      /** @type {unknown[] | Record<string, unknown>} */ (parameters || []),
    ))
  }

  /** @param {string} project @param {string} statement @param {unknown} parameters */
  async function executeInternal(project, statement, parameters) {
    assertStorageName(project, 'project', true)
    if (typeof statement !== 'string' || !statement.trim()) {
      throw new TypeError('statement must be a non-empty string')
    }
    const normalized = statement.trimStart()
    if (/^insert\s+or\s+replace\b/i.test(normalized)) return upsert(project, normalized, parameters, 'replace')
    if (/^(upsert|insert\s+or\s+update)\b/i.test(normalized)) return upsert(project, normalized, parameters, 'update')
    if (/^insert\b/i.test(normalized)) return insert(project, normalized, parameters)
    if (/^select\b/i.test(normalized)) return select(project, normalized, parameters)
    if (/^(get|find|collect)\b/i.test(normalized)) return getDocuments(project, normalized, parameters)
    if (/^update\b/i.test(normalized)) return update(project, normalized, parameters)
    if (/^delete\b/i.test(normalized)) return remove(project, normalized, parameters)
    if (/^(?:query\s+)?(?:on|in|over|with|use|using)\b/i.test(normalized)) {
      return rawQuery(project, normalized, parameters)
    }
    throw new Error('Unsupported IDB statement')
  }

  /**
   * Throwing API.
   * @param {string} project
   * @param {string} statement
   * @param {unknown} [parameters]
   */
  function execute(project, statement, parameters) {
    return track(() => executeInternal(project, statement, parameters))
  }

  /**
   * Compatibility API. It always resolves an envelope and also supports both
   * legacy Node-style callback overloads.
   * @param {string} project
   * @param {string} statement
   * @param {unknown | ((error: unknown, result?: unknown) => void)} [parameters]
   * @param {(error: unknown, result?: unknown) => void} [callback]
   */
  function run(project, statement, parameters, callback) {
    if (typeof parameters === 'function') {
      callback = /** @type {(error: unknown, result?: unknown) => void} */ (parameters)
      parameters = undefined
    }
    const promise = track(() => executeInternal(project, statement, parameters)).then(
      (result) => ({ error: null, result }),
      (error) => ({ error, result: undefined }),
    )
    if (callback) {
      promise.then(({ error, result }) => callback?.(error, result))
    }
    return promise
  }

  /** @param {string} [project] */
  async function close(project) {
    while (operations.size) await Promise.all([...operations])
    const matches = [...stores.entries()].filter(([key]) => !project || key.startsWith(`${project}\0`))
    await Promise.all(matches.map(async ([key, pending]) => {
      stores.delete(key)
      const store = await pending.catch(() => null)
      if (store) await store.close()
    }))
  }

  return Object.freeze({ run, execute, close })
}

const idb = createIdb()
export default idb
