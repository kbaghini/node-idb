import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { createIdb } from 'node-idb'

const storagePath = './.example-data/backup-source'
const destinationPath = './.example-data/backup-snapshot'
const source = createIdb({ storagePath })

let backup
try {
  // Make repeated runs produce the same logical source data.
  await source.execute('DELETE FROM notes')
  await source.execute('INSERT INTO notes', [
    { key: 'welcome', title: 'Welcome', published: true },
    { key: 'draft', title: 'Draft', published: false },
  ])

  backup = await source.backup({
    destinationPath,
    collections: ['notes'],
    integrityCheck: 'full',
    // Existing arbitrary directories are never replaced. This succeeds on a
    // repeat run only when the destination has a valid node-idb manifest.
    overwrite: true,
  })

  console.log('Backup result:', backup)
} finally {
  await source.close()
}

const manifest = JSON.parse(await readFile(
  path.join(backup.destinationPath, '.node-idb-backup.json'),
  'utf8',
))
console.log('Manifest consistency:', manifest.consistency)
console.table(manifest.files)

// Read-only mode opens current, complete disk storage without migration,
// index reconciliation, journal conversion, or file creation.
const snapshot = createIdb({
  storagePath: backup.destinationPath,
  mode: 'readonly',
  maxOpenCollections: 2,
})

try {
  console.log(await snapshot.execute('SELECT * FROM notes WHERE published = ?', [true]))

  try {
    await snapshot.execute('INSERT INTO notes', { key: 'blocked' })
  } catch (error) {
    console.log('Expected read-only rejection:', error.message)
  }
} finally {
  await snapshot.close()
}
