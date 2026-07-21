import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb } from 'node-idb'

const executeFile = promisify(execFile)
const cli = path.resolve('bin/node-idb.js')

test('the CLI inspects, verifies, restores, and explicitly migrates storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-idb-cli-'))
  const storagePath = path.join(root, 'source')
  const backupPath = path.join(root, 'backup')
  const restoredPath = path.join(root, 'restored')
  const database = createIdb({ storagePath })
  try {
    await database.execute('INSERT INTO records', { value: 1 })
    await database.backup({ destinationPath: backupPath })
  } finally {
    await database.close()
  }

  try {
    const inspect = JSON.parse((await executeFile(
      process.execPath,
      [cli, 'inspect', storagePath, '--integrity', 'none', '--json'],
    )).stdout)
    assert.equal(inspect.collections[0].schemaVersion, 5)

    const verified = JSON.parse((await executeFile(
      process.execPath,
      [cli, 'verify-backup', backupPath, '--json'],
    )).stdout)
    assert.deepEqual(verified.collections, ['records'])

    const restored = JSON.parse((await executeFile(
      process.execPath,
      [cli, 'restore', backupPath, restoredPath, '--json'],
    )).stdout)
    assert.equal(restored.replaced, false)

    await assert.rejects(
      executeFile(process.execPath, [cli, 'migrate', restoredPath]),
      /requires --yes/i,
    )
    const migrated = JSON.parse((await executeFile(
      process.execPath,
      [cli, 'migrate', restoredPath, '--yes', '--field-indexes', 'none', '--json'],
    )).stdout)
    assert.equal(migrated.after.collections[0].schemaVersion, 5)
    assert.equal(migrated.after.collections[0].fieldIndexes.default, 'none')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
