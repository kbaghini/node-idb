import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const executeFile = promisify(execFile)

test('benchmark JSON verifies streams and reports sampled memory and queued-write latency', async () => {
  const { stdout } = await executeFile(process.execPath, [
    'benchmarks/run.js', '--json', '--storage-path', ':memory:',
    '--documents', '24', '--insert-batch-size', '24', '--point-queries', '1',
    '--range-queries', '1', '--updates', '1', '--warmup-queries', '0',
    '--cache-churn-collections', '1', '--cache-churn-queries', '1',
    '--stream-batch-size', '7', '--slow-reader-rows', '12', '--slow-reader-delay-ms', '1',
    '--main-cache-kib', '1024', '--blob-cache-kib', '512', '--mmap-bytes', '0',
  ], { cwd: new URL('..', import.meta.url), timeout: 30000 })
  const report = JSON.parse(stdout)
  assert.equal(report.formatVersion, 2)
  assert.equal(report.phases.stream.items, 24)
  assert.equal(report.phases.slowReaderWriter.rowsConsumed, 12)
  assert.ok(report.phases.slowReaderWriter.writeDurationMs > 0)
  assert.deepEqual(report.configuration.databaseOptions.sqliteCache, {
    mainKiB: 1024, blobKiB: 512, mmapBytes: 0,
  })
  for (const phase of Object.values(report.phases)) {
    assert.ok(phase.memory.sampledPeakBytes.rss >= phase.memory.baselineBytes.rss)
    assert.ok(phase.memory.sampledPeakBytes.heapUsed >= phase.memory.endBytes.heapUsed)
  }
})
