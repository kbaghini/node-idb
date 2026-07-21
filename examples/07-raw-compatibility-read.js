import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/raw' })

try {
  await database.execute('INSERT INTO files', {
    key: 'example.txt',
    content: 'hello',
  })

  // QUERY ON is read-only and intended for physical diagnostics.
  console.table(await database.execute(
    'QUERY ON files SELECT id, name, level FROM tbl_fields ORDER BY id',
  ))
  console.table(await database.execute(
    'QUERY ON files EXPLAIN QUERY PLAN SELECT id FROM tbl_fields',
  ))
} finally {
  await database.close()
}
