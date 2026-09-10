// @ts-check

/**
 * Cache syntax only, never parameters, compiled SQL, or query results.
 * Serialized trees give each caller an independent mutable AST. Limits cover
 * retained UTF-16 text; Map/object overhead and transient parsing are additional.
 * @param {(sql: string) => Promise<any>} parse
 * @param {{maxEntries?: number, maxBytes?: number, maxSqlLength?: number}} [limits]
 */
export function createParseCache(parse, {
  maxEntries = 256, maxBytes = 2 * 1024 * 1024, maxSqlLength = 16384,
} = {}) {
  /** @type {Map<string, {tree: string, bytes: number}>} */
  const entries = new Map()
  let retainedBytes = 0
  return async function cachedParse(sql) {
    const hit = entries.get(sql)
    if (hit) {
      entries.delete(sql)
      entries.set(sql, hit)
      return JSON.parse(hit.tree)
    }
    const ast = await parse(sql)
    if (sql.length > maxSqlLength || maxEntries < 1) return ast
    const tree = JSON.stringify(ast)
    const bytes = 2 * (sql.length + tree.length)
    if (bytes > maxBytes) return ast
    // Concurrent misses may complete after an earlier call inserted this key.
    const previous = entries.get(sql)
    if (previous) {
      retainedBytes -= previous.bytes
      entries.delete(sql)
    }
    while (entries.size && (entries.size >= maxEntries || retainedBytes + bytes > maxBytes)) {
      const oldest = entries.keys().next().value
      const entry = entries.get(oldest)
      retainedBytes -= entry.bytes
      entries.delete(oldest)
    }
    entries.set(sql, {tree, bytes})
    retainedBytes += bytes
    return ast
  }
}
