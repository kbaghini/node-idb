import assert from 'node:assert/strict'
import {createIdb} from 'node-idb'

// A disposable in-memory shop. Product lists request only card fields;
// the detail view loads a complete document by indexed SKU when needed.
const db = createIdb({storagePath: ':memory:', fieldIndexes: {
  default: 'none', rules: [{collection: 'products', path: 'sku', enabled: true}],
}})
try {
  await db.execute('INSERT INTO products', Array.from({length: 8}, (_, i) => ({
    sku: `SKU-${i + 1}`, name: `Product ${i + 1}`, price: 10 + i,
    thumbnail: `/images/${i + 1}.webp`, stock: i + 2,
    description: 'Detailed product information. '.repeat(500),
    specifications: {color: 'blue', weightGrams: 250 + i},
  })))
  const limit = 5
  const rows = await db.execute(
    'SELECT object_id, sku, name, price, thumbnail, stock FROM products ORDER BY object_id LIMIT ?',
    [limit + 1],
  )
  const products = rows.slice(0, limit)
  assert.ok(products.every(product => !Object.hasOwn(product, 'description')))
  console.log({products, hasMore: rows.length > limit, nextCursor: rows.length > limit ? products.at(-1).object_id : null})

  const [detail] = await db.execute('SELECT * FROM products WHERE sku = ?', [products[0].sku])
  assert.ok(detail.description.length > 1000)
  console.log({detailSku: detail.sku, descriptionCharacters: detail.description.length})
  // Apply the same access and visibility filters to both list and detail queries.
  // Selecting fewer fields is an optimization, not a substitute for authorization.
} finally { await db.close() }
