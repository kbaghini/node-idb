import { createIdb } from 'node-idb'

const database = createIdb({
  storagePath: './.example-data/collection-structure',
  fieldIndexes: {
    default: 'none',
    rules: [
      { collection: 'people', path: 'contact.details.email', enabled: true },
    ],
  },
})

try {
  const [{ count }] = await database.execute('SELECT COUNT(*) AS count FROM people')
  if (count === 0) {
    await database.execute('INSERT INTO people', [
      {
        name: 'Ada Lovelace',
        contact: {
          details: { email: 'ada@example.test', phone: '+44-001' },
          labels: ['mathematics', 'computing'],
        },
      },
      {
        name: 'Grace Hopper',
        contact: {
          details: { email: 'grace@example.test' },
          labels: ['compilers', 'navy'],
        },
      },
      {
        name: 'Katherine Johnson',
        contact: null,
      },
    ])
  }

  // The complete observed collection tree.
  console.dir(await database.structure('people'), { depth: null })

  // Only this object field and its descendants are inspected.
  console.dir(await database.structure('people', {
    path: 'contact.details',
  }), { depth: null })
} finally {
  await database.close()
}
