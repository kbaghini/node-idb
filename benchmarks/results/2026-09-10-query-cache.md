# SQL syntax cache and targeted index review

Run `node benchmarks/query-cache.js` from the repository root. Raw measurements:
[JSON report](2026-09-10-query-cache.json).

Windows, Node.js 24.11.1, Intel Core i9-13900H. Three rounds with alternating
comparison order; medians below. The reported run was performed after the full
test suite finished to avoid its competing load. Each index run used fresh
temporary disk storage; each lookup checked the returned name and price.

| Workload | Without optimization | With optimization |
| --- | ---: | ---: |
| 200 repeated parses of the same parameterized SQL | 2736.16 ms | 1.09 ms |
| 200 SKU lookups in 10,000 products | 631.57 ms | 289.56 ms |
| Insert 10,000 products, no optional indexes vs SKU indexes | 347.27 ms | 384.94 ms |

The first row compares direct `sqlite-parser` calls against warmed `parseSql`
cache hits using identical standard SQL (no custom syntax preprocessing needed).
It measures syntax parsing only, not SQLite execution or HTTP response time.
The cache does not store query results, bound parameters, or schema-dependent
compiled SQL. A miss still incurs parsing cost. The cache holds at most 256
entries and 2 MiB of accounted SQL/serialized-AST UTF-16 text per loaded module;
Map/object overhead and transient allocations are additional. SQL longer than
16,384 UTF-16 code units bypasses storage. Exact SQL text is the key, so use
parameters to share templates. Each caller gets an independent AST.

The lookup comparison uses the syntax cache in both cases and enables only
the `products.sku` query/type indexes in the focused case. Median lookup time
improved by about 2.18x, while bulk insertion took about 11% longer. These are
single-process sequential warm-read measurements, not concurrent storefront
capacity guarantees, cold-cache results, or measurements of compound filters.

## Targeted indexing findings

The existing implementation already supports exact collection/path rules,
wildcards, persisted policy changes, and automatic policies with pinned rules.
Regression tests cover policy persistence, reopening, and independent engines.
Structural reconstruction indexes remain enabled when optional indexes are off.
Common scalar predicates compile to the per-field expression index, with a
fallback for values stored in the blob database.

No indexing engine change was needed for the measured SKU lookup. Enable
additional paths only for measured predicates. Separate `categoryId` and `price`
indexes are not a compound `(categoryId, price)` index: fields use separate
physical tables. Ordering alone does not guarantee a benefit from these indexes.
Do not impose an ecommerce policy globally on this general-purpose database.
