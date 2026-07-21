import { createIdb } from 'node-idb'
import { startStudio } from 'node-idb/studio'

const rootPath = './.example-data/studio'
const samplePath = `${rootPath}/development`

const sample = createIdb({ storagePath: samplePath })
try {
  const [{ count }] = await sample.execute('SELECT COUNT(*) AS count FROM people')
  if (count === 0) {
    await sample.execute('INSERT INTO people', [
      {
        name: 'Ada Lovelace',
        active: true,
        contact: { city: 'London' },
        tags: ['mathematics', 'computing'],
      },
      {
        name: 'Grace Hopper',
        active: true,
        contact: { city: 'New York' },
        tags: ['compilers', 'navy'],
      },
    ])
  }
} finally {
  await sample.close()
}

const studio = await startStudio({
  rootPath,
  port: 4177,
  writable: true,
})

console.log(`Open node-idb Studio: ${studio.url}`)
console.log('Press Ctrl+C to stop it.')

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await studio.close()
  process.exitCode = 0
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
