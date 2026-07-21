import { createIdb } from 'node-idb'

const database = createIdb({
  storagePath: './.example-data/operations',
  maxOpenCollections: 4,
})

try {
  await database.execute(
    'INSERT INTO events',
    Array.from({ length: 250 }, (_, id) => ({ id, category: id % 2 ? 'odd' : 'even' })),
  )

  for await (const event of database.stream(
    'SELECT * FROM events WHERE category = ? ORDER BY id',
    ['even'],
    { batchSize: 25, timeoutMs: 5_000 },
  )) {
    console.log(event)
  }

  console.dir(await database.diagnostics(), { depth: null })
  console.dir(await database.storageStats(), { depth: null })
  await database.analyze({ collections: ['events'] })
  await database.vacuum({ collections: ['events'] })
} finally {
  await database.close()
}
