import { createIdb } from 'node-idb'

// The filename is retained for compatibility; this example now demonstrates
// separate database instances instead of per-command project names.
const databaseRoot = './.example-data/separate-databases'
const development = createIdb({ storagePath: `${databaseRoot}/development` })
const production = createIdb({ storagePath: `${databaseRoot}/production` })

try {
  await development.execute('INSERT INTO settings', {
    theme: 'dark',
    debug: true,
  })
  await production.execute('INSERT INTO settings', {
    theme: 'light',
    debug: false,
  })

  console.log('Development:', await development.execute('SELECT * FROM settings'))
  console.log('Production:', await production.execute('SELECT * FROM settings'))
} finally {
  await Promise.all([development.close(), production.close()])
}
