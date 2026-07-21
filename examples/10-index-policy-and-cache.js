import { createIdb } from 'node-idb'

const database = createIdb({
  storagePath: './.example-data/index-policy-and-cache',

  // This limits retained disk connections, not the number of collections.
  // Sequentially accessing a third collection evicts the least-recently used
  // idle store and transparently reopens it when needed again.
  maxOpenCollections: 2,

  // Optional query/type indexes are persisted per schema-v5 collection.
  // Rules are ordered, collection matching is case-insensitive, document paths
  // are case-sensitive, and the last matching rule wins.
  fieldIndexes: {
    default: 'none',
    rules: [
      { collection: '*', path: 'key', enabled: true },
      { collection: 'users', path: 'email', enabled: true },
      { collection: 'events', pattern: 'context.**', enabled: true },
      { collection: 'events', pattern: 'context.private.**', enabled: false },
    ],
  },
})

try {
  // Make the example repeatable while also touching three collections.
  await database.execute('DELETE FROM users')
  await database.execute('DELETE FROM events')
  await database.execute('DELETE FROM settings')

  await database.execute('INSERT INTO users', {
    key: 'ada',
    email: 'ada@example.test',
    profile: { displayName: 'Ada' },
  })
  await database.execute('INSERT INTO events', {
    key: 'signed-in',
    context: {
      actor: { id: 'ada' },
      private: { token: 'not-indexed' },
    },
  })
  await database.execute('INSERT INTO settings', {
    key: 'theme',
    value: 'dark',
  })

  // users may have been evicted after events and settings were accessed; the
  // public result is unchanged when the cache transparently reopens it.
  console.log(await database.execute('SELECT * FROM users WHERE email = ?', [
    'ada@example.test',
  ]))
  console.log(await database.execute('SELECT * FROM events WHERE context.actor.id = ?', [
    'ada',
  ]))

  // An intentionally unindexed predicate remains correct; it may scan instead.
  console.log(await database.execute(
    'SELECT * FROM events WHERE context.private.token = ?',
    ['not-indexed'],
  ))
} finally {
  await database.close()
}
