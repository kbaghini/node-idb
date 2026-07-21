import { createIdb } from 'node-idb'
import { startStudio } from 'node-idb/studio'

const rootPath = './.example-data/beginner-studio'
const database = createIdb({ storagePath: rootPath })

try {
  const [{ count }] = await database.execute(
    'SELECT COUNT(*) AS count FROM greetings',
  )

  if (count === 0) {
    await database.execute('INSERT INTO greetings', {
      message: 'Open me in Studio!',
      tags: ['beginner', 'studio'],
      createdAt: new Date(),
    })
  }
} finally {
  await database.close()
}

const studio = await startStudio({ rootPath, port: 0 })

console.log(`Open this complete URL: ${studio.url}`)
console.log('Studio is read-only. Press Ctrl+C to stop it.')

async function shutdown() {
  await studio.close()
  process.exitCode = 0
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
