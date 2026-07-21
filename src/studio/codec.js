// @ts-check

const defaultLimits = Object.freeze({
  maxDepth: 128,
  maxNodes: 100_000,
  maxStringBytes: 8 * 1024 * 1024,
  maxBinaryBytes: 16 * 1024 * 1024,
})

/**
 * @typedef {{
 *   maxDepth?: number,
 *   maxNodes?: number,
 *   maxStringBytes?: number,
 *   maxBinaryBytes?: number,
 * }} StudioCodecLimits
 * @typedef {{
 *   limits: Required<StudioCodecLimits>,
 *   nodes: number,
 *   stringBytes: number,
 *   binaryBytes: number,
 * }} CodecContext
 */

/** @param {unknown} value */
function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {StudioCodecLimits | undefined} options */
function normalizeLimits(options) {
  if (options === undefined) return defaultLimits
  if (!isPlainObject(options)) throw new TypeError('Studio codec limits must be an object')
  const unknown = Object.keys(options).filter((key) => !Object.hasOwn(defaultLimits, key))
  if (unknown.length) throw new TypeError(`Unknown Studio codec limit: ${unknown.join(', ')}`)

  /** @type {Required<StudioCodecLimits>} */
  const limits = { ...defaultLimits, ...options }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
  return Object.freeze(limits)
}

/** @param {CodecContext} context @param {number} depth */
function countNode(context, depth) {
  if (depth > context.limits.maxDepth) {
    throw new RangeError(`Studio values cannot exceed ${context.limits.maxDepth} levels`)
  }
  context.nodes += 1
  if (context.nodes > context.limits.maxNodes) {
    throw new RangeError(`Studio values cannot exceed ${context.limits.maxNodes} nodes`)
  }
}

/** @param {CodecContext} context @param {string} value */
function countString(context, value) {
  context.stringBytes += Buffer.byteLength(value)
  if (context.stringBytes > context.limits.maxStringBytes) {
    throw new RangeError(
      `Studio value strings cannot exceed ${context.limits.maxStringBytes} UTF-8 bytes`,
    )
  }
}

/** @param {CodecContext} context @param {number} bytes */
function countBinary(context, bytes) {
  context.binaryBytes += bytes
  if (context.binaryBytes > context.limits.maxBinaryBytes) {
    throw new RangeError(
      `Studio value binaries cannot exceed ${context.limits.maxBinaryBytes} bytes`,
    )
  }
}

/** @param {unknown} value */
function binaryBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}

/**
 * Encodes one JavaScript value into the Studio's collision-proof JSON wire
 * format. Every value is represented by a tagged array, so no key inside a
 * user object is reserved.
 *
 * @param {unknown} value
 * @param {StudioCodecLimits} [options]
 * @returns {unknown[]}
 */
export function encodeStudioValue(value, options) {
  /** @type {CodecContext} */
  const context = {
    limits: normalizeLimits(options),
    nodes: 0,
    stringBytes: 0,
    binaryBytes: 0,
  }
  const seen = new WeakSet()

  /** @param {unknown} input @param {number} depth @returns {unknown[]} */
  function encode(input, depth) {
    countNode(context, depth)
    if (input === null) return ['null']
    if (input === undefined) return ['undefined']
    if (typeof input === 'boolean') return ['boolean', input]
    if (typeof input === 'number') {
      if (Number.isNaN(input)) return ['number', 'NaN']
      if (input === Infinity) return ['number', 'Infinity']
      if (input === -Infinity) return ['number', '-Infinity']
      return ['number', input]
    }
    if (typeof input === 'string') {
      countString(context, input)
      return ['string', input]
    }
    if (typeof input === 'bigint') {
      const serialized = input.toString()
      countString(context, serialized)
      return ['bigint', serialized]
    }
    if (input instanceof Date) {
      if (!Number.isFinite(input.getTime())) throw new TypeError('Studio dates must be valid')
      const serialized = input.toISOString()
      countString(context, serialized)
      return ['date', serialized]
    }

    const binary = binaryBuffer(input)
    if (binary) {
      countBinary(context, binary.length)
      return ['binary', binary.toString('base64')]
    }

    if (!input || typeof input !== 'object') {
      throw new TypeError(`Unsupported Studio value: ${typeof input}`)
    }
    if (!Array.isArray(input) && !isPlainObject(input)) {
      throw new TypeError(
        `Unsupported Studio value: ${input.constructor?.name || typeof input}`,
      )
    }
    if (seen.has(input)) throw new TypeError('Studio values cannot contain circular references')
    if (Object.getOwnPropertySymbols(input).length) {
      throw new TypeError('Studio values cannot contain symbol-keyed properties')
    }

    seen.add(input)
    try {
      if (Array.isArray(input)) {
        return ['array', Array.from(input, (entry) => encode(entry, depth + 1))]
      }
      return ['object', Object.entries(input).map(([key, entry]) => {
        countString(context, key)
        return [key, encode(entry, depth + 1)]
      })]
    } finally {
      seen.delete(input)
    }
  }

  return encode(value, 0)
}

/** @param {string} value @param {CodecContext} context */
function decodeBase64(value, context) {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new TypeError('Invalid base64 binary in Studio value')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  countBinary(context, (value.length / 4) * 3 - padding)
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) {
    throw new TypeError('Non-canonical base64 binary in Studio value')
  }
  return buffer
}

/**
 * Decodes and strictly validates one Studio wire value. Object properties are
 * installed as own data properties, including names such as `__proto__`, so
 * wire data can never alter the decoded object's prototype.
 *
 * @param {unknown} value
 * @param {StudioCodecLimits} [options]
 * @returns {unknown}
 */
export function decodeStudioValue(value, options) {
  /** @type {CodecContext} */
  const context = {
    limits: normalizeLimits(options),
    nodes: 0,
    stringBytes: 0,
    binaryBytes: 0,
  }

  /** @param {unknown} input @param {number} depth @returns {unknown} */
  function decode(input, depth) {
    countNode(context, depth)
    if (!Array.isArray(input) || typeof input[0] !== 'string') {
      throw new TypeError('Invalid Studio value node')
    }
    const tag = input[0]
    if (tag === 'null' || tag === 'undefined') {
      if (input.length !== 1) throw new TypeError(`Invalid ${tag} Studio value`)
      return tag === 'null' ? null : undefined
    }
    if (tag === 'boolean') {
      if (input.length !== 2 || typeof input[1] !== 'boolean') {
        throw new TypeError('Invalid boolean Studio value')
      }
      return input[1]
    }
    if (tag === 'number') {
      if (input.length !== 2) throw new TypeError('Invalid number Studio value')
      const payload = input[1]
      if (typeof payload === 'number' && Number.isFinite(payload)) return payload
      if (payload === 'NaN') return Number.NaN
      if (payload === 'Infinity') return Infinity
      if (payload === '-Infinity') return -Infinity
      throw new TypeError('Invalid number Studio value')
    }
    if (tag === 'string') {
      if (input.length !== 2 || typeof input[1] !== 'string') {
        throw new TypeError('Invalid string Studio value')
      }
      countString(context, input[1])
      return input[1]
    }
    if (tag === 'bigint') {
      if (
        input.length !== 2 ||
        typeof input[1] !== 'string' ||
        !/^-?\d+$/.test(input[1])
      ) {
        throw new TypeError('Invalid bigint Studio value')
      }
      countString(context, input[1])
      return BigInt(input[1])
    }
    if (tag === 'date') {
      if (input.length !== 2 || typeof input[1] !== 'string') {
        throw new TypeError('Invalid date Studio value')
      }
      countString(context, input[1])
      const date = new Date(input[1])
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== input[1]) {
        throw new TypeError('Invalid ISO date in Studio value')
      }
      return date
    }
    if (tag === 'binary') {
      if (input.length !== 2 || typeof input[1] !== 'string') {
        throw new TypeError('Invalid binary Studio value')
      }
      return decodeBase64(input[1], context)
    }
    if (tag === 'array') {
      if (input.length !== 2 || !Array.isArray(input[1])) {
        throw new TypeError('Invalid array Studio value')
      }
      return input[1].map((entry) => decode(entry, depth + 1))
    }
    if (tag === 'object') {
      if (input.length !== 2 || !Array.isArray(input[1])) {
        throw new TypeError('Invalid object Studio value')
      }
      /** @type {Record<string, unknown>} */
      const result = {}
      const keys = new Set()
      for (const pair of input[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
          throw new TypeError('Invalid object entry in Studio value')
        }
        const key = pair[0]
        if (keys.has(key)) throw new TypeError(`Duplicate Studio object key: ${key}`)
        keys.add(key)
        countString(context, key)
        Object.defineProperty(result, key, {
          value: decode(pair[1], depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return result
    }
    throw new TypeError(`Unknown Studio value tag: ${tag}`)
  }

  return decode(value, 0)
}
