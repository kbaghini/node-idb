import assert from 'node:assert/strict'
import { createIdb } from 'node-idb'
import { startStudio, decodeStudioValue } from 'node-idb/studio'

const db = createIdb({ storagePath: './data', sqliteCache: { mainKiB: 1024, mmapBytes: 0 } })
const document = { id: 1, name: 'نصب مستقل', createdAt: new Date(1234), counter: 42n, bytes: Buffer.from([1, 2, 3]) }
try {
  await db.execute('INSERT INTO records', document)
  assert.deepEqual(await db.execute('FIND records'), [document])
  const rows = []
  for await (const row of db.stream('SELECT id FROM records')) rows.push(row)
  assert.deepEqual(rows.map((row) => row.id), [1])
} finally {
  await db.close()
}

const studio = await startStudio({ rootPath: './data', port: 0 })
try {
  const url = new URL(studio.url)
  const token = new URLSearchParams(url.hash.slice(1)).get('token')
  const headers = { Authorization: `Bearer ${token}`, Origin: url.origin, 'Content-Type': 'application/json' }
  for (const asset of ['/', '/studio.js', '/studio.css']) {
    const response = await fetch(new URL(asset, url))
    assert.equal(response.status, 200)
    assert.ok((await response.text()).length > 100)
  }
  assert.equal((await fetch(new URL('/api/state', url))).status, 401)
  const stateResponse = await fetch(new URL('/api/state', url), { headers })
  assert.equal(stateResponse.status, 200)
  const state = await stateResponse.json()
  const response = await fetch(new URL('/api/query', url), {
    method: 'POST', headers,
    body: JSON.stringify({ databaseId: state.databases[0].id, statement: 'SELECT * FROM records' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(decodeStudioValue((await response.json()).rows), [document])
} finally {
  await studio.close()
}
