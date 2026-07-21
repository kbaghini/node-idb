import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/beginner' })

try {
  await database.execute('INSERT INTO greetings', {
    message: 'Hello, node-idb!',
    createdAt: new Date(),
  })

  const greetings = await database.execute('SELECT * FROM greetings')
  console.log(greetings)
} finally {
  await database.close()
}
