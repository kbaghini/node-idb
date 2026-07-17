import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/callbacks' })

const callbackRun = (statement, ...args) => new Promise((resolve, reject) => {
  database.run('legacy', statement, ...args, (error, result) => {
    if (error) reject(error)
    else resolve(result)
  })
})

try {
  await callbackRun('INSERT INTO files', { key: 'main.js', content: 'export default true' })
  console.log(await callbackRun('GET files'))

  // The Promise envelope is useful when migrating older callers.
  const outcome = await database.run('legacy', "GET files WHERE key='main.js'")
  console.log(outcome.error, outcome.result)

  // Fire-and-forget callback calls remain supported.
  database.run('legacy', "UPDATE files SET content='updated' WHERE key='main.js'", (error) => {
    if (error) console.error(error)
  })
} finally {
  await database.close()
}
