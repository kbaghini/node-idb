# Prepared read statement reuse

Run `node benchmarks/prepared-reads.js`. [Raw results](2026-09-10-prepared-reads.json).

Windows, Node.js 24.11.1, Intel Core i9-13900H. A single in-memory SQLite
connection contains 10,000 products indexed by SKU. Both paths execute the same
parameterized SQL and verify every result. Five rounds alternate path order,
with 30 warmup reads followed by 1,000 measured sequential reads per path.

| Path | Median time for 1,000 reads |
| --- | ---: |
| Native `database.all`, preparing/finalizing each time | 82.01 ms |
| Reused prepared statement | 50.00 ms |

That is about 39% less elapsed time (1.64x throughput) in this focused test.
This measures SQLite execution overhead, including the JavaScript wrapper;
it excludes node-idb syntax parsing, SQL compilation, document reconstruction,
disk latency and HTTP. It is not an end-to-end storefront improvement or a
concurrent capacity guarantee.

## Implementation boundaries

- At most 32 retained/in-use cached statements per connection, with LRU eviction.
- Only `all()` reads beginning with SELECT or the generated dataset CTE are
  considered. SQL is limited to 16,384 UTF-16 code units for retention.
- Bindings must be nonempty arrays of at most 32 numbers, nulls or strings of
  at most 128 code units. Larger, empty, named, binary and other bindings use
  the original path. This also bounds retained bound-value sizes; native query
  plan memory varies and is not covered by a fixed byte-budget guarantee.
- node-sqlite3 clears old bindings when binding a nonempty array. Empty arrays
  do not clear previous values, which is why they must bypass cached handles.
- A busy SQL template takes the ordinary path instead of sharing a live cursor.
- Results are fully consumed; streaming, single-row get and writes are unchanged.
- Failed/interrupted handles are finalized. Closing drains cached operations
  and finalizes retained handles before closing the SQLite connection.
- SQLite's prepare-v2 automatic schema recompilation is retained; tests cover
  dropping/recreating tables, parameter omission, concurrent values, cache limits,
  interrupted reads and closing with a read in flight.

Query results are not cached and no storage-format migration is required.
