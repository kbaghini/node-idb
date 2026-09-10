import {createIdb} from 'node-idb'

// An in-memory demo; no persistent application data is changed.
const db = createIdb({storagePath: ':memory:'})
try {
  await db.execute('INSERT INTO products', Array.from({length: 12}, (_, i) => ({
    sku: `SKU-${i + 1}`, name: `Product ${i + 1}`, price: i + 10,
  })))
  const limit = 5
  let after = null
  for (;;) {
    // Read one extra projected row to determine whether a next page exists.
    const rows = await db.execute(
      `SELECT object_id, name, price FROM products${after === null ? '' : ' WHERE object_id > ?'} ORDER BY object_id LIMIT ?`,
      after === null ? [limit + 1] : [after, limit + 1],
    )
    const page = rows.slice(0, limit)
    console.log(page)
    if (rows.length <= limit) break
    after = page.at(-1).object_id
  }
  // For descending order use object_id < ? with ORDER BY object_id DESC.
  // IDs can have gaps. Use the returned ID, never page-number arithmetic.
  // For price ordering, use a price + unique-ID boundary and measure its plan.
} finally { await db.close() }
