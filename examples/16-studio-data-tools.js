import { createIdb } from 'node-idb'
import { startStudio } from 'node-idb/studio'

const database = createIdb({ storagePath: './.example-data/tools/live' })
try {
  for (const [collection, stock] of [['catalog', 5], ['proposed', 8]]) {
    await database.execute(`INSERT IF ABSENT INTO ${collection} WHERE sku = $sku`,
      { sku: 'A-100', name: 'Keyboard', stock, updatedAt: new Date('2026-01-01') })
  }
} finally {
  await database.close()
}

const studio = await startStudio({
  rootPath: './.example-data/tools',
  backupPath: './.example-data/tools-backups',
  writable: true,
  port: 0,
})
console.log(studio.url)
console.log('Choose catalog → Data tools. Compare with proposed using sku; try export, review, and backups.')
process.once('SIGINT', async () => { await studio.close() })
process.once('SIGTERM', async () => { await studio.close() })
