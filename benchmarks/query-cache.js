// Run from the repository root: node benchmarks/query-cache.js
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import sqliteParser from 'sqlite-parser'
import { createIdb } from '../src/index.js'
import { parseSql } from '../src/idb/sql.js'

const sql = 'SELECT name, price FROM products WHERE sku = ?'
const uncached = () => new Promise((resolve, reject) => {
  sqliteParser(sql, (error, ast) => error ? reject(error) : resolve(ast.statement[0]))
})
assert.deepEqual(await parseSql(sql), await uncached())
const report = {node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
  parseIterations: 200, parse: [], documents: 10000, lookups: 200, indexes: []}
for (let round = 0; round < 3; round++) {
  for (const mode of round % 2 ? ['cached', 'uncached'] : ['uncached', 'cached']) {
    const operation = mode === 'cached' ? () => parseSql(sql) : uncached
    for (let i = 0; i < 10; i++) await operation()
    const started = performance.now()
    for (let i = 0; i < report.parseIterations; i++) await operation()
    report.parse.push({round, mode, ms: performance.now() - started})
  }
}
const products = Array.from({length: report.documents}, (_, i) => ({
  sku: `SKU-${i}`, name: `Product ${i}`, price: i + 1, category: `category-${i % 20}`,
}))
for (let round = 0; round < 3; round++) {
  for (const mode of round % 2 ? ['focused', 'none'] : ['none', 'focused']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-query-cache-'))
    const db = createIdb({storagePath: root, fieldIndexes: mode === 'none' ? 'none' : {
      default: 'none', rules: [{collection: 'products', path: 'sku', enabled: true}],
    }})
    try {
      const insertStarted = performance.now()
      await db.execute('INSERT INTO products', products)
      const insertMs = performance.now() - insertStarted
      for (let i = 0; i < 20; i++) await db.execute(sql, [`SKU-${i}`])
      const started = performance.now()
      for (let i = 0; i < report.lookups; i++) {
        const id = (i * 47) % report.documents
        const rows = await db.execute(sql, [`SKU-${id}`])
        assert.equal(rows.length, 1)
        assert.equal(rows[0].name, `Product ${id}`)
        assert.equal(rows[0].price, id + 1)
      }
      report.indexes.push({round, mode, insertMs, lookupMs: performance.now() - started})
    } finally {
      await db.close()
      await rm(root, {recursive: true, force: true})
    }
  }
}
console.log(JSON.stringify(report, null, 2))
