import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/callbacks' })

const callbackRun = (statement, ...args) => new Promise((resolve, reject) => {
  database.run(statement, ...args, (error, result) => {
    if (error) reject(error)
    else resolve(result)
  })
})

try {
  // Callback overloads emit NODE_IDB_RUN_CALLBACK once per process. They stay
  // available through 0.x, but new code should use execute().
  await callbackRun('INSERT INTO files', { key: 'main.js', content: 'export default true' })
  console.log(await callbackRun('SELECT * FROM files'))

  // Promise-based run() is not deprecated and keeps a non-throwing envelope.
  const outcome = await database.run("SELECT * FROM files WHERE key='main.js'")
  console.log(outcome.error, outcome.result)

  // Existing fire-and-forget callbacks remain supported during migration.
  database.run("UPDATE files SET content='updated' WHERE key='main.js'", (error) => {
    if (error) console.error(error)
  })
} finally {
  await database.close()
}
