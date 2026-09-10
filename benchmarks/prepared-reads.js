import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import os from 'node:os'
import {openDatabase, all, exec, closeDatabase} from '../src/idb/database.js'

// Isolate SQLite execution overhead: both paths run exactly the same indexed SQL.
// This excludes node-idb parsing/compilation and HTTP, and is not a capacity test.
const db = await openDatabase(':memory:')
const report = {node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
  storage: ':memory:', documents: 10000, reads: 1000, runs: []}
try {
  await exec(db, `CREATE TABLE products (sku INTEGER PRIMARY KEY, name TEXT, price INTEGER);
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO products SELECT x, 'Product ' || x, x+10 FROM n`)
  const sql = 'SELECT name, price FROM products WHERE sku = ?'
  for (let round = 0; round < 5; round++) {
    for (const mode of round % 2 ? ['cached', 'native'] : ['native', 'cached']) {
      const read = parameters => mode === 'cached' ? all(db, sql, parameters) :
        new Promise((resolve, reject) => db.all(sql, parameters, (error, rows) => error ? reject(error) : resolve(rows)))
      for (let i = 0; i < 30; i++) await read([1])
      const started = performance.now()
      for (let i = 0; i < report.reads; i++) {
        const id = (i * 47) % report.documents + 1
        assert.deepEqual(await read([id]), [{name: `Product ${id}`, price: id + 10}])
      }
      report.runs.push({round, mode, ms: performance.now() - started})
    }
  }
  console.log(JSON.stringify(report, null, 2))
} finally { await closeDatabase(db) }
