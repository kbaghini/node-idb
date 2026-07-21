import { setTimeout as delay } from 'node:timers/promises'

import { createIdb } from 'node-idb'

// Ordinary applications can omit fieldIndexes: new storage uses the balanced
// automatic policy. Lower thresholds here make the learning cycle visible in
// a small example.
const database = createIdb({
  storagePath: './.example-data/automatic-indexing',
  fieldIndexes: {
    mode: 'auto',
    preset: 'aggressive',
    minDocuments: 0,
    minQueryCount: 3,
    evaluationInterval: 3,
    cooldownMs: 0,
    maxResultRatio: 1,
    rules: [
      { collection: 'users', path: 'id', enabled: true },
      { collection: 'users', pattern: 'private.**', enabled: false },
    ],
  },
})

try {
  await database.execute('INSERT INTO users', [
    { id: 1, email: 'ada@example.test', private: { token: 'a' } },
    { id: 2, email: 'grace@example.test', private: { token: 'b' } },
  ])

  for (let index = 0; index < 3; index++) {
    await database.execute('SELECT * FROM users u WHERE u.email = ?', ['ada@example.test'])
  }

  // Observation persistence and index changes are deferred from the query.
  await delay(300)
  console.dir((await database.diagnostics()).openCollections[0].autoIndexing, {
    depth: null,
  })

  console.dir(await database.optimizeIndexes({ dryRun: true }), { depth: null })
} finally {
  await database.close()
}
