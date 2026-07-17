import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/raw' })

try {
  await database.execute('diagnostics', 'INSERT INTO files', {
    key: 'example.txt',
    content: 'hello',
  })

  // Raw prefixes are read-only and intended for diagnostics/legacy callers.
  console.table(await database.execute(
    'diagnostics',
    'QUERY ON files SELECT id, name, level FROM tbl_fields ORDER BY id',
  ))
  console.table(await database.execute(
    'diagnostics',
    'ON files EXPLAIN QUERY PLAN SELECT id FROM tbl_fields',
  ))
} finally {
  await database.close()
}
