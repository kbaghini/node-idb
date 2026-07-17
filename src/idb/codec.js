// @ts-check

export const ValueType = Object.freeze({
  null: 0,
  true: 1,
  false: 2,
  bigint: 3,
  number: 4,
  date: 5,
  string: 6,
  text: 7,
  array: 8,
  object: 9,
  binary: 10,
})

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
const structuredTag = '__ev3_idb_type__'

/** @param {unknown} value */
export function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {string} key */
export function assertFieldName(key) {
  if (unsafeKeys.has(key)) throw new Error(`Unsafe document field name: ${key}`)
  if (key.includes('.')) {
    throw new Error(`Document field names cannot contain dots: ${key}`)
  }
  if (key.includes('\0')) throw new Error('Document field names cannot contain null bytes')
}

/** @param {unknown} value */
function binaryBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return null
}

/**
 * JSON-safe encoding for atomic arrays. It supports more native values than
 * the legacy BigInt-only replacer while remaining able to read legacy arrays.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @param {number} [depth]
 * @returns {unknown}
 */
function encodeStructured(value, seen, depth = 0) {
  if (depth > 128) throw new RangeError('Array nesting cannot exceed 128 levels')
  if (typeof value === 'bigint') return { [structuredTag]: 'bigint', value: value.toString() }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('Array dates must be valid')
    return { [structuredTag]: 'date', value: value.getTime() }
  }

  const binary = binaryBuffer(value)
  if (binary) return { [structuredTag]: 'binary', value: binary.toString('base64') }

  if (value === undefined) return { [structuredTag]: 'undefined' }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Array numbers must be finite')
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (!value || typeof value !== 'object') {
    throw new TypeError(`Unsupported array value: ${typeof value}`)
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError(`Unsupported array value: ${value.constructor?.name || typeof value}`)
  }
  if (seen.has(value)) throw new TypeError('Documents cannot contain circular references')

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => encodeStructured(entry, seen, depth + 1))
    }
    const entries = Object.entries(value)
    if (
      Object.hasOwn(value, structuredTag) ||
      (entries.length === 1 && entries[0][0] === '__idb_bigint__')
    ) {
      return {
        [structuredTag]: 'record',
        value: entries.map(([key, entry]) => {
          assertFieldName(key)
          return [key, encodeStructured(entry, seen, depth + 1)]
        }),
      }
    }
    const result = Object.create(null)
    for (const [key, entry] of entries) {
      assertFieldName(key)
      result[key] = encodeStructured(entry, seen, depth + 1)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/** @param {unknown} value @param {number} [depth] @returns {any} */
function decodeStructured(value, depth = 0) {
  if (depth > 128) throw new RangeError('Stored array nesting exceeds 128 levels')
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => decodeStructured(entry, depth + 1))

  const record = /** @type {Record<string, any>} */ (value)
  const keys = Object.keys(record)
  if (keys.length === 1 && typeof record.__idb_bigint__ === 'string') {
    return BigInt(record.__idb_bigint__)
  }

  if (typeof record[structuredTag] === 'string' && keys.length <= 2) {
    const hasValue = keys.length === 2 && Object.hasOwn(record, 'value')
    if (record[structuredTag] === 'bigint' && hasValue) return BigInt(record.value)
    if (record[structuredTag] === 'date' && hasValue) return new Date(Number(record.value))
    if (record[structuredTag] === 'binary' && hasValue) {
      return Buffer.from(String(record.value), 'base64')
    }
    if (record[structuredTag] === 'undefined' && keys.length === 1) return undefined
    if (record[structuredTag] === 'record' && Array.isArray(record.value)) {
      /** @type {Record<string, any>} */
      const decoded = {}
      for (const entry of record.value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          throw new Error('Invalid escaped object in stored array')
        }
        assertFieldName(entry[0])
        decoded[entry[0]] = decodeStructured(entry[1], depth + 1)
      }
      return decoded
    }
  }

  /** @type {Record<string, any>} */
  const result = {}
  for (const [key, entry] of Object.entries(record)) {
    assertFieldName(key)
    result[key] = decodeStructured(entry, depth + 1)
  }
  return result
}

/**
 * @typedef {{ key: string, parentIndex: number | null, level: number, type: number, value: unknown, childCount: number }} EncodedNode
 */

/**
 * @param {unknown} document
 * @param {string} collection
 * @returns {Promise<EncodedNode[]>}
 */
export async function encodeDocument(document, collection) {
  /** @type {EncodedNode[]} */
  const nodes = []
  const seen = new WeakSet()

  /**
   * @param {unknown} value
   * @param {string} key
   * @param {number | null} parentIndex
   * @param {number} level
   */
  async function visit(value, key, parentIndex, level) {
    if (level > 128) throw new RangeError('Document nesting cannot exceed 128 levels')
    if (parentIndex !== null) assertFieldName(key)

    const index = nodes.length
    /** @type {EncodedNode} */
    const node = { key, parentIndex, level, type: ValueType.null, value: null, childCount: 0 }
    nodes.push(node)

    if (value === null || value === undefined) node.type = ValueType.null
    else if (value === true) node.type = ValueType.true
    else if (value === false) node.type = ValueType.false
    else if (typeof value === 'bigint') {
      node.type = ValueType.bigint
      node.value = value.toString()
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Document numbers must be finite')
      node.type = ValueType.number
      node.value = value
    } else if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new TypeError('Document dates must be valid')
      node.type = ValueType.date
      node.value = value.getTime()
    } else if (typeof value === 'string') {
      node.type = value.length < 256 ? ValueType.string : ValueType.text
      node.value = value
    } else {
      const binary = binaryBuffer(value)
      if (binary) {
        node.type = ValueType.binary
        node.value = binary
      } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
        node.type = ValueType.binary
        node.value = Buffer.from(await value.arrayBuffer())
      } else if (Array.isArray(value)) {
        node.type = ValueType.array
        node.value = JSON.stringify(encodeStructured(value, new WeakSet()))
      } else if (isPlainObject(value)) {
        if (seen.has(value)) throw new TypeError('Documents cannot contain circular references')
        seen.add(value)
        try {
          const entries = Object.entries(value)
          node.type = ValueType.object
          node.childCount = entries.length
          node.value = entries.length
          for (const [childKey, childValue] of entries) {
            await visit(childValue, childKey, index, level + 1)
          }
        } finally {
          seen.delete(value)
        }
      } else {
        throw new TypeError(`Unsupported document value: ${value?.constructor?.name || typeof value}`)
      }
    }
    return index
  }

  await visit(document, collection, null, 0)
  return nodes
}

/**
 * @param {number} type
 * @param {unknown} numberValue
 * @param {unknown} stringValue
 * @param {unknown} blobValue
 */
export function decodeValue(type, numberValue, stringValue, blobValue) {
  if (
    (type === ValueType.text || type === ValueType.array || type === ValueType.binary) &&
    blobValue == null
  ) {
    throw new Error(`IDB integrity error: missing blob payload for stored type ${type}`)
  }
  if (type === ValueType.null) return null
  if (type === ValueType.true) return true
  if (type === ValueType.false) return false
  if (type === ValueType.bigint) return BigInt(String(stringValue))
  if (type === ValueType.number) return Number(numberValue)
  if (type === ValueType.date) return new Date(Number(numberValue))
  if (type === ValueType.string) return stringValue == null ? '' : String(stringValue)
  if (type === ValueType.text) return blobValue == null ? '' : String(blobValue)
  if (type === ValueType.array) {
    const source = Buffer.isBuffer(blobValue) ? blobValue.toString('utf8') : String(blobValue ?? '[]')
    return decodeStructured(JSON.parse(source))
  }
  if (type === ValueType.object) return {}
  if (type === ValueType.binary) {
    if (Buffer.isBuffer(blobValue)) return Buffer.from(blobValue)
    if (blobValue instanceof Uint8Array) return Buffer.from(blobValue)
    return Buffer.from(/** @type {any} */ (blobValue ?? ''))
  }
  return numberValue ?? stringValue ?? blobValue
}

/** @param {unknown} value @returns {any} */
export function deepClone(value) {
  if (value instanceof Date) return new Date(value.getTime())
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (Array.isArray(value)) return value.map(deepClone)
  if (isPlainObject(value)) {
    /** @type {Record<string, any>} */
    const result = {}
    for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      result[key] = deepClone(entry)
    }
    return result
  }
  return value
}

/**
 * Recursively merges object payloads; arrays and scalar values replace.
 * @param {unknown} target
 * @param {unknown} source
 */
export function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return deepClone(source)
  const result = deepClone(target)
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (source))) {
    assertFieldName(key)
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : deepClone(value)
  }
  return result
}
