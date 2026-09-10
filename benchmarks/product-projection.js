import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {gzipSync} from 'node:zlib'
import {createIdb} from '../src/index.js'

const fields = ['sku', 'name', 'price', 'thumbnail', 'stock']
const card = row => Object.fromEntries(fields.map(field => [field, row[field]]))
const report = {node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
  documents: 1000, pageSize: 25, repeats: 30, workloads: []}

for (const descriptionLength of [128, 16384]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-projection-'))
  const db = createIdb({storagePath: root, fieldIndexes: 'none'})
  try {
    for (let start = 0; start < report.documents; start += 100) {
      await db.execute('INSERT INTO products', Array.from({length: 100}, (_, i) => {
        const id = start + i
        return {sku: `SKU-${id}`, name: `Product ${id}`, price: 10 + id,
          thumbnail: `/images/${id}.webp`, stock: id % 20,
          description: `Detailed specification for product ${id}. `.repeat(500).slice(0, descriptionLength),
          specifications: {color: ['red', 'blue', 'green'][id % 3], weightGrams: 100 + id},
        }
      }))
    }
    const workload = {descriptionLength, samples: {}, runs: []}
    const read = mode => db.execute(
      `SELECT ${mode === 'full' ? '*' : fields.join(', ')} FROM products ORDER BY object_id LIMIT ?`,
      [report.pageSize],
    )
    const full = await read('full')
    assert.equal(full.length, report.pageSize)
    const expected = full.map(card)
    for (const mode of ['full', 'projected']) {
      const rows = await read(mode)
      assert.deepEqual(rows.map(card), expected)
      const json = JSON.stringify(rows)
      workload.samples[mode] = {jsonBytes: Buffer.byteLength(json), gzipBytes: gzipSync(json).length}
    }
    for (let round = 0; round < 3; round++) {
      for (const mode of round % 2 ? ['projected', 'full'] : ['full', 'projected']) {
        for (let i = 0; i < 5; i++) await read(mode)
        let readMs = 0, serializeMs = 0
        for (let i = 0; i < report.repeats; i++) {
          const started = performance.now()
          const rows = await read(mode)
          const loaded = performance.now()
          const json = JSON.stringify(rows)
          const serialized = performance.now()
          readMs += loaded - started
          serializeMs += serialized - loaded
          assert.deepEqual(rows.map(card), expected)
          assert.equal(Buffer.byteLength(json), workload.samples[mode].jsonBytes)
        }
        workload.runs.push({round, mode, readMs, serializeMs})
      }
    }
    report.workloads.push(workload)
  } finally {
    await db.close()
    await rm(root, {recursive: true, force: true})
  }
}
console.log(JSON.stringify(report, null, 2))
