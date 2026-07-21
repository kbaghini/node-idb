import { createIdb, inspectStorage, restoreBackup, verifyBackup } from 'node-idb'

const source = createIdb({ storagePath: './.example-data/restore-source' })
try {
  await source.execute('INSERT INTO settings', { theme: 'dark', version: 1 })
  await source.backup({
    destinationPath: './.example-data/restore-backup',
    overwrite: true,
    integrityCheck: 'full',
  })
} finally {
  await source.close()
}

console.dir(await verifyBackup({
  backupPath: './.example-data/restore-backup',
  integrityCheck: 'full',
}), { depth: null })

console.dir(await restoreBackup({
  backupPath: './.example-data/restore-backup',
  destinationPath: './.example-data/restored',
  overwrite: true,
}), { depth: null })

console.dir(await inspectStorage({
  storagePath: './.example-data/restored',
  integrityCheck: 'quick',
}), { depth: null })
