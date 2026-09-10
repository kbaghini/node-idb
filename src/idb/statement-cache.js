// Bounded, connection-local cache for fully consumed parameterized reads.
// Streaming cursors, get(), writes and unusual/large bindings keep their existing path.
const caches = new WeakMap()
const MAX_ENTRIES = 32

function eligible(sql, parameters) {
  return sql.length <= 16384 && /^\s*(?:SELECT\b|WITH "__idb_dataset" AS\s*\()/i.test(sql) &&
    Array.isArray(parameters) && parameters.length > 0 && parameters.length <= 32 &&
    parameters.every(value => value === null || typeof value === 'number' ||
      (typeof value === 'string' && value.length <= 128))
}

function finalize(statement) {
  return new Promise((resolve, reject) => statement.finalize(error => error ? reject(error) : resolve()))
}

export function cachedAll(database, sql, parameters, fallback) {
  if (!eligible(sql, parameters)) return fallback()
  let cache = caches.get(database)
  if (!cache) {
    cache = {idle: new Map(), busy: new Set(), active: new Set(), closing: false}
    caches.set(database, cache)
  }
  if (cache.closing) return Promise.reject(new Error('Database is closing'))
  // Never rebind a statement in use by another request; preserve concurrency.
  if (cache.busy.has(sql) || cache.busy.size >= MAX_ENTRIES) return fallback()
  const cached = cache.idle.get(sql)
  cache.idle.delete(sql)
  cache.busy.add(sql)
  const operation = (async () => {
    let statement = cached
    try {
      if (!statement) {
        if (cache.idle.size + cache.busy.size > MAX_ENTRIES) {
          const oldest = cache.idle.keys().next().value
          const evicted = cache.idle.get(oldest)
          cache.idle.delete(oldest)
          await finalize(evicted)
        }
        statement = await new Promise((resolve, reject) => {
          const prepared = database.prepare(sql, error => error ? reject(error) : resolve(prepared))
        })
      }
      const rows = await new Promise((resolve, reject) => {
        // Nonempty arrays cause node-sqlite3 to reset AND clear prior bindings.
        statement.all(parameters, (error, result) => error ? reject(error) : resolve(result))
      })
      cache.idle.set(sql, statement)
      statement = undefined
      return rows
    } finally {
      try {
        // Failed or interrupted statements are discarded, never returned to the cache.
        if (statement) await finalize(statement).catch(() => {})
      } finally {
        cache.busy.delete(sql)
      }
    }
  })()
  cache.active.add(operation)
  operation.then(() => cache.active.delete(operation), () => cache.active.delete(operation))
  return operation
}

export async function closeStatementCache(database) {
  const cache = caches.get(database)
  if (!cache) return
  cache.closing = true
  await Promise.allSettled([...cache.active])
  const statements = [...cache.idle.values()]
  cache.idle.clear()
  const outcomes = await Promise.allSettled(statements.map(finalize))
  const failed = outcomes.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
}
