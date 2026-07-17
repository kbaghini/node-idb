import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/queries' })

try {
  await database.execute('analytics', 'INSERT INTO people', [
    { name: 'Ada', score: 91, address: { city: 'Tehran', country: 'IR' }, role: 'admin' },
    { name: 'Bob', score: 72, address: { city: 'Tabriz', country: 'IR' }, role: 'user' },
    { name: 'Cara', score: 85, address: { city: 'Shiraz', country: 'IR' }, role: 'admin' },
  ])

  // Explicit aliases preserve the exact output names you choose.
  console.table(await database.execute(
    'analytics',
    `SELECT person.name AS person,
            person.address.city AS city,
            person.score AS score
       FROM people AS person
      WHERE person.score >= $minimum
      ORDER BY person.score DESC
      LIMIT $limit`,
    { $minimum: 80, $limit: 2 },
  ))

  // A bare ambiguous leaf returns full-path aliases.
  console.table(await database.execute('analytics', 'SELECT city FROM people'))

  // ? means immediate children; * means recursive descendants.
  console.dir(await database.execute('analytics', 'SELECT address.? FROM people LIMIT 1'), { depth: null })
  console.dir(await database.execute('analytics', 'SELECT address.* FROM people LIMIT 1'), { depth: null })

  console.table(await database.execute(
    'analytics',
    `SELECT role, COUNT(*) AS total, AVG(score) AS average
       FROM people
      GROUP BY role
      HAVING total > 0
      ORDER BY role`,
  ))
} finally {
  await database.close()
}
