import { isPlainObject } from './codec.js'

export function normalizeSqliteCache(value = {}) {
  if (!isPlainObject(value)) throw new TypeError('sqliteCache must be an options object')
  const defaults = { mainKiB: 16384, blobKiB: 8192, mmapBytes: 268435456 }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown sqliteCache option: ${key}`)
  }
  const result = { ...defaults }
  for (const key of Object.keys(defaults)) {
    const number = value[key] === undefined ? defaults[key] : value[key]
    const minimum = key === 'mmapBytes' ? 0 : 1
    if (!Number.isSafeInteger(number) || number < minimum || number > 2147483647) {
      throw new RangeError(`sqliteCache.${key} must be an integer from ${minimum} through 2147483647`)
    }
    result[key] = number
  }
  return Object.freeze(result)
}
