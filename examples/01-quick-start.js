import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/quick-start' })

try {
  const objectId = await database.execute('demo', 'INSERT INTO notes', {
    title: 'First note',
    body: 'Hello from node-idb',
    tags: ['sqlite', 'node'],
  })

  console.log('Inserted object ID:', objectId)
  console.log(await database.execute('demo', 'GET notes'))
} finally {
  await database.close()
}
