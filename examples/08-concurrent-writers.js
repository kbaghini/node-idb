import { createIdb } from 'node-idb'

const storagePath = './.example-data/concurrency'
const first = createIdb({ storagePath })
const second = createIdb({ storagePath })

try {
  await first.execute('INSERT INTO counters', {
    key: 'requests',
    total: 0,
  })

  // This simulates two processes opening the same database directory. Within
  // one process, normally share one engine for each storage path.
  await Promise.all([
    first.execute("UPDATE counters WHERE key='requests'", { firstWorker: true }),
    second.execute("UPDATE counters WHERE key='requests'", { secondWorker: true }),
  ])

  console.dir(await first.execute('SELECT * FROM counters'), { depth: null })
} finally {
  await Promise.all([first.close(), second.close()])
}
