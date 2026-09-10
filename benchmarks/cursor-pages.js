import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {createIdb} from '../src/index.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-cursor-bench-'))
const db = createIdb({storagePath: root, fieldIndexes: 'none'})
const report = {node: process.version, cpu: os.cpus()[0].model, documents: 100000, pageSize: 25, repeats: 30, runs: []}
try {
  for (let start = 0; start < report.documents; start += 1000) {
    await db.execute('INSERT INTO products', Array.from({length: 1000}, (_, i) => ({sku: `sku-${start + i}`, price: i})))
  }
  for (const offset of [25, 50000, 99975]) {
    const [anchor] = await db.execute('SELECT object_id FROM products ORDER BY object_id LIMIT 1 OFFSET ?', [offset - 1])
    const read = mode => mode === 'offset'
      ? db.execute('SELECT object_id FROM products ORDER BY object_id LIMIT ? OFFSET ?', [25, offset])
      : db.execute('SELECT object_id FROM products WHERE object_id > ? ORDER BY object_id LIMIT ?', [anchor.object_id, 25])
    const expected = await read('offset')
    for (let round = 0; round < 3; round++) {
      for (const mode of round % 2 ? ['cursor', 'offset'] : ['offset', 'cursor']) {
        for (let i = 0; i < 5; i++) await read(mode)
        const started = performance.now()
        for (let i = 0; i < report.repeats; i++) assert.deepEqual(await read(mode), expected)
        report.runs.push({offset, round, mode, ms: performance.now() - started})
      }
    }
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await db.close()
  await rm(root, {recursive: true, force: true})
}
