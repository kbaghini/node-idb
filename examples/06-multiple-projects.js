import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/multiple-projects' })

try {
  await database.execute('development', 'INSERT INTO settings', {
    theme: 'dark',
    debug: true,
  })
  await database.execute('production', 'INSERT INTO settings', {
    theme: 'light',
    debug: false,
  })

  console.log('Development:', await database.execute('development', 'GET settings'))
  console.log('Production:', await database.execute('production', 'GET settings'))

  // Close only one project's open collection handles.
  await database.close('development')
  console.log('Reopened development:', await database.execute('development', 'GET settings'))
} finally {
  await database.close()
}
