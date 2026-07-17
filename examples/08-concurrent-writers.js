import { createIdb } from 'node-idb'

const storagePath = './.example-data/concurrency'
const first = createIdb({ storagePath })
const second = createIdb({ storagePath })

try {
  await first.execute('shared', 'INSERT INTO counters', {
    key: 'requests',
    total: 0,
  })

  // Independent engines serialize their read/modify/write transactions.
  await Promise.all([
    first.execute('shared', "UPDATE counters WHERE key='requests'", { firstWorker: true }),
    second.execute('shared', "UPDATE counters WHERE key='requests'", { secondWorker: true }),
  ])

  console.dir(await first.execute('shared', 'GET counters'), { depth: null })
} finally {
  await Promise.all([first.close(), second.close()])
}
