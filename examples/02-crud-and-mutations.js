import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './.example-data/crud' })

try {
  await database.execute('shop', 'INSERT INTO products', [
    { sku: 'A-100', name: 'Keyboard', stock: 4, price: 49.5 },
    { sku: 'B-200', name: 'Mouse', stock: 12, price: 19.9 },
  ])

  // Payload-style UPDATE deep-merges nested objects.
  await database.execute('shop', "UPDATE products WHERE sku='A-100'", {
    stock: 3,
    metadata: { featured: true },
  })

  // SET expressions are evaluated by SQLite.
  await database.execute(
    'shop',
    "UPDATE products SET price=ROUND(price*1.1, 2), stock=stock+2 WHERE sku='A-100'",
  )

  // UPSERT merges a match and inserts when there is no match.
  await database.execute('shop', "UPSERT INTO products WHERE sku='A-100'", {
    sku: 'A-100',
    metadata: { clearance: false },
  })
  await database.execute('shop', "UPSERT INTO products WHERE sku='C-300'", {
    sku: 'C-300',
    name: 'Webcam',
    stock: 5,
    price: 79,
  })

  // REPLACE removes fields omitted by the replacement document.
  await database.execute('shop', "INSERT OR REPLACE INTO products WHERE sku='B-200'", {
    sku: 'B-200',
    name: 'Silent Mouse',
    stock: 10,
    price: 24.9,
  })

  await database.execute('shop', "DELETE metadata FROM products WHERE sku='A-100'")
  await database.execute('shop', "DELETE FROM products WHERE sku='C-300'")
  console.dir(await database.execute('shop', 'GET products ORDER BY sku'), { depth: null })
} finally {
  await database.close()
}
