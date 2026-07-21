import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/types' })

try {
  const document = {
    key: 'all-supported-types',
    createdAt: new Date('2026-07-17T12:34:56.789Z'),
    largeInteger: 9_007_199_254_740_993n,
    thumbnail: Buffer.from([0, 1, 2, 255]),
    longText: 'long text '.repeat(40),
    values: [1, undefined, 3n, { enabled: true }],
    profile: { displayName: 'Ada', settings: { darkMode: true } },
  }

  await database.execute('INSERT INTO documents', document)
  const [loaded] = await database.execute('SELECT * FROM documents')

  console.log('Date:', loaded.createdAt instanceof Date, loaded.createdAt)
  console.log('BigInt:', typeof loaded.largeInteger, loaded.largeInteger)
  console.log('Buffer:', Buffer.isBuffer(loaded.thumbnail), loaded.thumbnail)
  console.dir(loaded.values, { depth: null })
  console.dir(loaded.profile, { depth: null })
} finally {
  await database.close()
}
