# node-idb

`node-idb` is an embedded, server-side document store for Node.js built on
SQLite. It stores JavaScript-shaped documents locally, preserves useful native
types, and provides a compact document API with a practical SQL-style query
language.

It is designed for applications that want **local, durable, queryable document
storage without operating a separate database server**. It is not intended to
replace PostgreSQL, MongoDB, or another client/server database when data must be
shared across many application servers or written heavily by many processes.

> **Short recommendation:** choose `node-idb` for one Node.js application on
> one machine, low-to-moderate write concurrency, stable document shapes, and
> small or medium documents. Do not choose it for distributed deployments,
> unbounded dynamic field names, very large media documents, or workloads that
> need many simultaneous writers.

## Executive summary

| Question | Answer |
| --- | --- |
| What is it? | A typed document layer over embedded SQLite. |
| Where does it run? | In a Node.js server process, on the same machine as its database files. |
| What does it store? | Plain objects, nested objects, atomic arrays, strings, finite numbers, booleans, `null`, `BigInt`, `Date`, and binary data. |
| How is it queried? | `GET`, `FIND`, `COLLECT`, document mutations, and a supported SQL-style `SELECT` subset. |
| Is it transactional? | Yes. Each mutation is atomic, including values split between the main and blob databases. |
| Is it serverless? | Yes in the database sense: no database daemon is required. Your Node.js application remains the server for remote clients. |
| What is the best workload? | Local application data, caches, catalogs, configuration, metadata, offline-capable services, and low-to-medium traffic single-host applications. |
| What is the main scaling boundary? | SQLite serializes writers to each collection database, and `node-idb` creates storage structures for every distinct field path. |
| What document size is preferred? | Usually below 100 KB. Documents up to about 1 MB can be reasonable when measured on the target system. Larger documents require deliberate testing. |
| Is there a hard document-size setting? | No single `node-idb` document limit. SQLite, Node.js memory, value encoding, disk capacity, and transaction duration impose the real limits. |
| How mature is it? | It is a young `0.x` package with a comprehensive automated test suite, but it should be evaluated and load-tested before critical production use. |

## Who should use it?

We recommend `node-idb` when most of these statements are true:

- Your Node.js process and the data files live on the same physical machine.
- You want an embedded database with no database server to install or manage.
- Your data is naturally document-shaped but SQL-style filtering, projection,
  grouping, ordering, and aggregation are still useful.
- Document shapes are reasonably stable across a collection.
- Reads are more common than writes, or writes are short and can queue.
- A single application process, or a small number of cooperating processes,
  owns the data.
- You value local files, simple deployment, transactional durability, and easy
  backup over horizontal database scaling.
- You need to retain `Date`, `BigInt`, arrays, nested objects, or binary values
  without manually mapping every value to JSON.
- Your application is a desktop/local service, edge application, small website,
  internal tool, test fixture store, build cache, content catalog, job metadata
  store, or single-host API.

Typical good fits include:

| Use case | Why it fits |
| --- | --- |
| Desktop or local-first application backend | Data stays beside the application and needs no administrator. |
| Embedded device or edge service | SQLite is self-contained and works without a database daemon. |
| Small-to-medium single-server API | The application server serializes short writes and serves remote clients through its own API. |
| Metadata or content catalog | Documents are easy to model and scalar fields remain queryable. |
| Configuration, templates, and application resources | Typed nested data and transactional replacement are useful. |
| Local cache of a remote system | Low latency, offline reads, and simple invalidation/replacement. |
| Tests, prototypes, and development tools | Isolated storage paths and `mem:<name>` collections are convenient. |
| Migration from the original HIS/EV3 IDB module | Legacy v0/v2 files and callback behavior are supported. |

## Who should not use it?

We do not recommend `node-idb` when any of these are central requirements:

- Multiple application servers must directly share the same files.
- The database files are on NFS, SMB, a synchronized cloud-drive folder, or
  another network filesystem.
- Many processes must commit writes to the same collection at the same time.
- You need horizontal scaling, replicas, automatic failover, sharding, change
  streams, or multi-region operation.
- You need cross-collection joins, foreign keys between documents, arbitrary
  SQL/DDL, stored procedures, or a complete relational database interface.
- You need a MongoDB-compatible query language or ecosystem.
- You need built-in authentication, authorization, encryption at rest,
  compression, auditing, replication, or remote administration.
- Your documents use arbitrary IDs, timestamps, URLs, or user-provided strings
  as object keys. Use an array of `{ key, value }` entries or a dedicated
  collection instead.
- Individual documents are normally many megabytes or contain videos, large
  archives, or other stream-oriented payloads.
- Large arrays must be filtered or updated by individual element. Arrays are
  atomic values in `node-idb`.
- You need transactions spanning multiple public API calls or multiple
  collections.
- You require a mature `1.x` API and a long public production track record
  today.

For those workloads, consider PostgreSQL, MongoDB, another client/server
database, or object storage combined with a database for metadata. SQLite's own
[appropriate-use guide](https://www.sqlite.org/whentouse.html) makes the same
fundamental distinction: SQLite is strongest when the data is local and writer
concurrency is modest.

## Advantages

- **Zero database-server administration.** Install the npm package and choose a
  storage directory.
- **Document-shaped data.** Nested plain objects are reconstructed by `GET`,
  `FIND`, and `COLLECT`.
- **Native values.** `Date`, `BigInt`, arrays, buffers, typed arrays, and
  `ArrayBuffer` values round-trip without application-side JSON conventions.
- **Useful SQL concepts.** Predicates, projections, aliases, grouping,
  aggregates, ordering, limits, offsets, expressions, and parameters compose.
- **Transactional writes.** Document replacement and its external blob values
  commit as one crash-atomic SQLite transaction.
- **Predictable alias handling.** Exact paths, leaf-name ambiguity, wildcards,
  and explicit aliases follow documented deterministic rules.
- **Automatic scalar indexes.** Common equality, range, `IN`, `BETWEEN`,
  `LIKE`, and `GLOB` predicates can use per-field indexes.
- **No JSON-only compromise.** Binary data and integers larger than JavaScript's
  safe integer range are preserved.
- **Simple isolation.** Each project and collection has separate files;
  `createIdb({ storagePath })` makes test isolation straightforward.
- **Legacy compatibility.** Existing HIS/EV3 storage, statements, Promise
  envelopes, and callbacks can be migrated incrementally.
- **Inspectability.** The physical files remain SQLite databases that standard
  SQLite tools can inspect for diagnostics.

## Tradeoffs and costs

- **One writer per collection database at a time.** Writers wait rather than
  running concurrently. Different collections use different files, but a hot
  collection can still become a write bottleneck.
- **A table-and-index cost per distinct field path.** Every new path found in a
  collection creates a value table and indexes. Stable schemas work well;
  unbounded dynamic keys cause schema growth, slower initialization, more disk
  usage, and more write work.
- **Whole-document mutation cost.** Payload-style updates read, merge, encode,
  and rewrite matched documents. Updating a tiny property in a huge document
  is therefore not cheap.
- **Arrays are atomic.** Their contents are serialized as one value and cannot
  be individually indexed or addressed by the query language.
- **Large text and binary values use fallback query paths.** They are preserved,
  but they do not have the same compact scalar-index behavior as short values.
- **Two files per disk-backed collection.** Backups must preserve the matching
  main and blob files together.
- **No public multi-operation transaction API.** Each `execute()` mutation is a
  transaction; an application cannot currently group several calls into one
  atomic unit.
- **SQL-style, not full SQL.** Statements are compiled against one document
  collection. Cross-collection joins and arbitrary write SQL are intentionally
  outside the public API.
- **Memory is part of the limit.** Documents and atomic arrays are encoded and
  decoded in process. The API does not stream document properties or BLOBs.
- **Automatic indexing increases write amplification.** It improves common
  reads at the cost of more schema objects, index pages, and mutation work.
- **Young package.** Version `0.x` means APIs and storage behavior must be
  reviewed carefully before upgrades.

## Document size and shape guidance

The following values are **conservative design guidance, not enforced limits or
performance guarantees**. Hardware, filesystem, cache behavior, query patterns,
write frequency, and Node.js memory settings matter. Benchmark representative
data on the target system before committing to a design.

| Area | Preferred starting point | Caution zone | Usually choose another representation |
| --- | --- | --- | --- |
| Complete document | Up to roughly 100 KB | 100 KB to 1 MB; measure reads and rewrites | Regularly above 1 MB, especially write-heavy documents |
| One text or binary property | Up to roughly 100 KB | Hundreds of KB to a few MB | Large media, archives, backups, or stream-oriented files |
| Leaf/path count per document | Tens; preferably below 100 | Low hundreds; benchmark write and open time | Many hundreds or thousands of distinct paths |
| Distinct field paths across a collection | Stable and shared by documents | Growing into the hundreds | Unbounded keys unique to each document |
| Atomic array | Small or moderate bounded lists | Large arrays read or replaced as a unit | Arrays whose elements need queries, indexes, or partial updates |
| Insert batch | Small bounded chunks | Hundreds of small documents per call | Huge batches that create long write locks or high memory pressure |
| Collection database | Comfortably fits local disk and backup windows | Multi-GB stores should be load- and recovery-tested | Data that must span machines or approach local operational limits |

### Why 100 KB is a useful starting point

SQLite reports that small BLOBs can be competitive with, and often faster than,
separate filesystem files. Its historical measurements found a crossover around
100 KB on the tested setup, while emphasizing that results vary by system. See
[Internal Versus External BLOBs](https://www.sqlite.org/intern-v-extern-blob.html)
and [35% Faster Than The Filesystem](https://www.sqlite.org/fasterthanfs.html).

For `node-idb`, 100 KB is also a useful application-design boundary because
documents are materialized in JavaScript and payload-style mutations rewrite
the matched document. It is not a cliff: a 300 KB document may work perfectly
for an infrequently updated catalog, while a frequently rewritten 50 KB
document may deserve profiling.

### Guidance for large files

For large images, videos, PDFs, archives, or generated artifacts, prefer:

1. Store the bytes in the filesystem or object storage.
2. Store the URI/path, checksum, MIME type, size, ownership, and searchable
   metadata in `node-idb`.
3. Use atomic file-replacement and application-level cleanup rules so metadata
   and files do not drift apart.

Small thumbnails, compact attachments, and other bounded binary properties can
remain convenient inside `node-idb`. Always test on the actual operating system
and storage device.

### Guidance for dynamic data

Avoid this shape when keys grow without a fixed bound:

```js
{
  readings: {
    '2026-07-19T10:00:00Z': 12,
    '2026-07-19T10:01:00Z': 13,
  },
}
```

Each timestamp becomes a distinct field path. Prefer a bounded array when its
contents are always read as one unit, or separate documents when readings must
be queried:

```js
{ sensorId: 'alpha', timestamp: new Date(), value: 12 }
```

The same rule applies to user IDs, UUIDs, URLs, filenames, and other values that
might otherwise become property names.

## Hard and implementation limits

`node-idb` applies these explicit limits:

| Limit | Current behavior |
| --- | --- |
| Project name | 1–128 characters after an optional `mem:` prefix |
| Collection name | 1–128 characters |
| Storage-name characters | Letters, numbers, underscores, and hyphens; at least one letter, number, or underscore |
| Document/array nesting | Maximum 128 levels |
| Field-name dots | Rejected because `.` separates nested paths |
| Field-name null bytes | Rejected |
| Prototype-sensitive field names | `__proto__`, `prototype`, and `constructor` are rejected |
| Numbers | Must be finite JavaScript numbers; use `BigInt` for larger exact integers |
| Dates | Must contain a valid timestamp |
| Object types | Only plain objects or objects with a `null` prototype are accepted |
| Circular references | Rejected |
| Write lock wait | SQLite busy timeout is 10 seconds per collection connection |

There is no separate `node-idb` maximum for the length of an ordinary field
name or for the number of properties in one document. Those values are bounded
indirectly by SQLite storage, memory, and the 128-level nesting rule. In
practice, very long names waste schema and index space, and large property
counts are expensive because each distinct path creates persistent schema
objects. Keep names concise and field sets bounded even though no small hard
limit is enforced.

SQLite supplies additional upper bounds. `node-idb` does not promise that
values close to these theoretical maxima are practical:

| SQLite boundary | Typical/current build value | Effect on `node-idb` |
| --- | --- | --- |
| One string, BLOB, or encoded SQLite row | 1,000,000,000 bytes | A single long text, binary value, or serialized array must remain below the active SQLite length limit and fit process memory. |
| Result columns / selected terms | 2,000 | Extremely wide flat `SELECT` projections can hit the SQLite column limit. Document reconstruction is internally chunked and is not equivalent to one column per property. |
| Bound SQL variables | 32,766 | Extremely large application-supplied parameter lists, especially `IN (...)`, can hit the build's variable limit. |
| Compound `SELECT` terms | 500 | Very complex generated or raw diagnostic reads can hit this boundary. |
| Expression depth | 1,000 | Deeply nested SQL expressions can fail even when document nesting is valid. |
| Pages per database file | 4,294,967,294 | With a 4 KiB page size this is about 17.6 TB per SQLite file; filesystem and operational limits normally arrive much earlier. |

These values depend on the SQLite build delivered by the installed `sqlite3`
dependency and may change. SQLite documents its defaults and compile-time
options in [Limits In SQLite](https://www.sqlite.org/limits.html). At the maximum
64 KiB page size, SQLite's theoretical file-size ceiling is about 281 TB, but
that is not a sensible capacity target for this package.

There is no small fixed maximum number of documents or collections in
`node-idb`. Real limits include disk space, filesystem file-size limits, schema
size, open file descriptors, available memory, query latency, backup duration,
and recovery objectives. Each disk-backed collection creates two database
files and may hold an open connection while active.

## Concurrency and deployment limits

- Writes are serialized within an engine and by SQLite's file locks.
- SQLite permits only one active writer per collection database file pair.
- A writer waits for up to 10 seconds before a busy error is returned.
- Readers use stable SQLite snapshots and do not observe half-written local
  documents.
- Separate collections use separate file pairs, so partitioning unrelated hot
  data into sensible collections can reduce lock contention.
- Long batches and large document rewrites keep the write lock longer and
  reduce effective concurrency.
- Database files should be stored on a local filesystem. Do not place live
  files on a network share or a consumer file-sync folder.
- Remote clients should call your Node.js application API; they should not open
  the SQLite files themselves.

If many writers cannot wait their turn, use a client/server database. SQLite's
[appropriate-use guide](https://www.sqlite.org/whentouse.html) explains this
boundary in detail.

## Operational limitations

`node-idb` currently does not provide built-in:

- Online backup orchestration or point-in-time recovery
- Replication, clustering, leader election, or failover
- Schema validation or application-level migrations
- Encryption at rest or field-level encryption
- Compression
- User authentication, roles, or row-level permissions
- Change streams, subscriptions, triggers exposed as an API, or reactive events
- Time-to-live indexes or automatic expiry
- Full-text search or vector search
- Geospatial indexes
- Cross-collection joins or foreign-key relationships
- Streaming reads/writes for large properties
- User-controlled transactions spanning multiple calls
- Automatic collection compaction, archival, or retention policies
- A browser IndexedDB implementation; despite its historical name, this is a
  Node.js package backed by SQLite

These features can be implemented at the application layer where appropriate,
but applications that fundamentally depend on several of them should usually
select a database designed around those requirements.

## Backup and recovery

Every disk-backed collection has a matching pair:

```text
db-collection-<collection>.sqlite
db-blobs-<collection>.sqlite
```

Treat the pair as one logical database. For a simple offline backup:

1. Stop writes and call `await database.close()`.
2. Copy both files for every collection in the project.
3. Preserve filenames and directory structure.
4. Test restoration periodically rather than assuming a copied backup works.

Do not copy only the main file: long text, arrays, and binary payloads may live
in the matching blob file. For live production backups, use a filesystem
snapshot or a carefully designed SQLite-aware procedure and verify consistency
across both attached databases. Always back up before opening legacy data with
a newer package version.

## Install

```bash
npm install node-idb
```

Node.js 20.19 or newer is required. The package is ESM.

## Quick start

```js
import { createIdb } from 'node-idb'

const database = createIdb({ storagePath: './data/idbs' })

const objectId = await database.execute('portal', 'INSERT INTO users', {
  email: 'user@example.test',
  profile: { name: 'Example User', theme: 'dark' },
  active: true,
  createdAt: new Date(),
})

const users = await database.execute(
  'portal',
  'GET users WHERE active = ? ORDER BY createdAt DESC LIMIT 20',
  [true],
)

console.log(objectId, users)
await database.close()
```

## Examples

The package includes a progression from first use to concurrent writers and
legacy compatibility. Run any example from the package root with
`node examples/<file>.js`.

See [examples/README.md](examples/README.md) for the complete guide.

- [01 Quick start](examples/01-quick-start.js)
- [02 CRUD and mutations](examples/02-crud-and-mutations.js)
- [03 SQL queries and aliases](examples/03-sql-queries-and-aliases.js)
- [04 Typed and binary data](examples/04-types-and-binary-data.js)
- [05 Callback compatibility](examples/05-callback-compatibility.js)
- [06 Multiple projects](examples/06-multiple-projects.js)
- [07 Raw compatibility reads](examples/07-raw-compatibility-read.js)
- [08 Concurrent writers](examples/08-concurrent-writers.js)

## Public API

```js
import idb, { createIdb } from 'node-idb'

// The default instance stores files below <process.cwd()>/idbs.
const objectId = await idb.execute('portal', 'INSERT INTO files', {
  key: 'main.js',
  content: Buffer.from('export default true'),
})

// Isolated instance, useful for another deployment or tests.
const database = createIdb({ storagePath: 'D:/data/idbs' })
```

The default instance uses `<process.cwd()>/idbs`. For most applications,
prefer `createIdb()` so the database lifecycle is explicit and test instances
can use isolated temporary directories.

### `execute(project, statement, parameters?)`

Returns the direct operation result and rejects on an error.

```js
const files = await database.execute(
  'portal',
  'GET files WHERE key = $key',
  { $key: 'main.js' },
)
```

### `run(project, statement, parameters?, callback?)`

Preserves both current and legacy behavior. It always resolves an envelope and
also accepts either Node-style callback overload:

```js
const outcome = await database.run('portal', 'GET files')
// { error: null, result: [...] } or { error, result: undefined }

database.run('portal', 'GET files', (error, result) => {})
database.run('portal', 'GET files WHERE key=?', ['main.js'], (error, result) => {})
```

### `close(project?)`

Closes all collection handles for one project. With no project, it closes the
whole engine. A later operation lazily reopens persisted data.

## Statements and results

| Statement | Behavior | Result |
| --- | --- | --- |
| `INSERT [INTO] collection` | Inserts one payload, or a batch when the payload is an array | object ID, or an array of IDs |
| `GET collection ...` | Reconstructs complete typed documents | document array |
| `FIND collection ...` | Alias of `GET` | document array |
| `COLLECT collection ...` | Alias of `GET` | document array |
| `SELECT ... FROM collection ...` | Runs a flat SQLite-style projection | row array |
| `UPDATE collection ...` + payload | Deep-merges the payload into every match | `{ object_id }[]` |
| `UPDATE collection SET ...` | Evaluates SQLite expressions, then replaces assigned paths | `{ object_id }[]` |
| `UPSERT [INTO] collection ...` | Deep-merges matches or inserts a miss | `{ object_id, inserted? }[]` |
| `INSERT OR UPDATE [INTO] ...` | Alias of `UPSERT` | `{ object_id, inserted? }[]` |
| `INSERT OR REPLACE [INTO] ...` | Truly replaces matches; omitted fields are removed | `{ object_id, inserted? }[]` |
| `DELETE FROM collection ...` | Deletes complete matching documents | `{ object_id }[]` |
| `DELETE fields FROM collection ...` | Deletes selected paths and rewrites each match | `{ object_id }[]` |

Legacy full-delete syntax such as `DELETE files FROM files WHERE ...` remains
supported.

An array is a batch payload on an insert/upsert miss. It is rejected when a
payload-style `UPDATE`, `UPSERT`, or `INSERT OR REPLACE` already has matches,
because treating the same array as both SQL bindings and one replacement
document would be ambiguous and potentially destructive.

`WHERE`, logical/comparison operators, `IN`, `BETWEEN`, `LIKE`, `GLOB`,
`ESCAPE`, `IS NULL`, grouping, `HAVING`, aggregates, `DISTINCT`, ordering,
limits, offsets, `CASE`, and safe SQLite scalar functions compose through the
SQL compiler. SQL keywords used as collection or field names must be quoted:

```sql
SELECT entry.`order`, entry.`shipping-address.zip-code`
FROM `order-log` AS entry
WHERE entry.`group` = ?
```

Non-aggregate, non-`DISTINCT` projections include `object_id` unless it is
explicitly selected. Aggregates and `DISTINCT` do not receive an implicit ID.
An explicit ID alias is honored:

```sql
SELECT item.object_id AS "DocumentID", item.name FROM items AS item
```

## Parameters

Positional placeholders receive an array. Named `$name` placeholders receive
an object whose key may be `$name` or `name`; the dollar-prefixed key wins even
when its value is `null`.

```js
await database.execute('app', 'GET users WHERE age >= ? AND active = ?', [18, true])
await database.execute('app', 'GET users WHERE email = $email', {
  $email: 'user@example.test',
})
```

Direct `SET` parameters preserve native document types, including `Date`,
`BigInt`, buffers, arrays, and plain objects. Assigning one field directly to
another also preserves its logical type. Formula results use SQLite result
types:

```js
await database.execute(
  'app',
  'UPDATE users SET profile=$profile, visits=visits+1 WHERE id=$id',
  { $id: 7, $profile: { theme: 'dark' } },
)
```

## Paths, wildcards, and aliases

Dots represent object nesting and are therefore rejected inside actual field
names. Quoting a dotted name refers to that exact stored path; it does not turn
the dot into a literal key.

- `?` selects immediate top-level children.
- `profile.?` selects immediate children of `profile`.
- `profile.*` selects every descendant of `profile`.
- `*` selects every stored document field recursively.

The same path wildcards work in field-deletion lists.

Alias resolution is deterministic:

1. An explicit `AS` alias wins and its source spelling is preserved.
2. An exact dotted path wins over leaf matching.
3. A unique bare leaf resolves wherever it is nested.
4. An ambiguous bare leaf projects every match under full-path aliases.
5. Ambiguous positive predicates match any path; negative predicates require
   every matching path to satisfy the negative condition.
6. Exact matching is attempted first, followed by a case-insensitive fallback.

For example, if both `home.city` and `work.city` exist, `SELECT city` returns
both keys. Use `SELECT home.city AS residence` for one stable output name.

## Stored and selected types

`GET`/`FIND`/`COLLECT` reconstruct the logical document. Flat `SELECT` keeps
SQLite-compatible scalar behavior while decoding blob-backed payloads.

| Input | Document read | Flat `SELECT` |
| --- | --- | --- |
| `null` / property `undefined` | `null` | `null` |
| boolean | boolean | `0` or `1` |
| finite number | number | number |
| `BigInt` | `BigInt` | decimal string |
| valid `Date` | `Date` | epoch milliseconds |
| string / long text | string | string |
| array | array, including nested typed values | array |
| plain object | nested object | selected object node is its child count; descendants are selectable |
| `Buffer`, typed array, `ArrayBuffer`, or `Blob` | `Buffer` | `Buffer` |

Arrays are atomic values rather than queryable child collections. `undefined`
inside an array is preserved. Binary values inside arrays are base64-encoded as
part of the array's JSON representation, which increases their encoded size.
Circular references, non-finite numbers, invalid dates, unsupported class
instances, prototype-sensitive keys, literal dots, and excessive nesting are
rejected before commit.

Blob-backed rows whose external payload is missing are reported as an integrity
error rather than silently decoded as empty data.

## Storage, migration, and durability

The default file layout is:

```text
idbs/
  <project>/
    db-collection-<collection>.sqlite
    db-blobs-<collection>.sqlite
```

Legacy populated v0/v2 files are opened and upgraded in place; document IDs and
the separate blob files are retained. Project and collection storage names may
contain letters, numbers, underscores, and hyphens. A project such as
`-system-` remains valid. A project named `mem:<name>` creates non-persistent
collection stores.

Main and blob databases are attached to one SQLite connection. Disk-backed
stores use rollback journals with `synchronous=FULL`, allowing SQLite's
multi-file super-journal to commit both files atomically. Writes use
`BEGIN IMMEDIATE`, a 10-second busy timeout, an in-process queue, and a catalog
refresh after acquiring the write lock. Read/modify/write operations are one
transaction, and multi-query document reads use a stable snapshot.

Common scalar equality, range, `IN`, `BETWEEN`, `LIKE`, and `GLOB` predicates
use per-field indexes. Blob-backed long text, array, and binary values retain a
semantically equivalent fallback. Wide result reads are internally chunked
below common SQLite bind and compound-query limits.

As with every in-place database upgrade, take a filesystem backup before the
first production deployment.

## Raw compatibility reads

The legacy prefixes `ON`, `IN`, `OVER`, `WITH`, `USE`, and `USING`, optionally
preceded by `QUERY`, run a physical query against a collection connection:

```sql
QUERY ON files SELECT id, name FROM tbl_fields ORDER BY id
```

Only `SELECT` and `EXPLAIN` are accepted. Raw reads share the engine's snapshot
queue, so they cannot observe a local document halfway through replacement.
These statements expose internal tables and should be limited to diagnostics
or existing compatibility code.

## Production evaluation checklist

Before adopting `node-idb` for production:

1. Model dynamic keys as values or separate documents.
2. Generate representative documents and measure insert, query, update, and
   startup time at expected and 2–5× expected volume.
3. Test the largest document, array, binary value, and batch you will accept.
4. Test concurrent writers and confirm that a 10-second busy timeout is
   acceptable.
5. Set application-level maximum sizes for documents, arrays, strings, binary
   values, query limits, and batches. Do not expose SQLite's theoretical limits
   to untrusted input.
6. Put storage on a local durable filesystem with sufficient free-space
   monitoring.
7. Define and test backup, restore, retention, and corruption-response
   procedures for both files in every collection pair.
8. Decide how encryption, authentication, authorization, and audit logging are
   handled outside the package.
9. Pin and review package upgrades; back up before opening production files with
   a new version.
10. Reconsider a client/server database if write concurrency, dataset size, or
    multi-host requirements are likely to grow materially.

## Project status and support

`node-idb` is currently a `0.x` package. Its test suite covers the public API,
SQL behavior, typed values, legacy migration, concurrency, corruption
detection, aliasing, wide reads, and indexed predicates. Tests reduce risk but
do not replace application-specific load, failure, and recovery testing.

Report reproducible defects and documentation gaps through the repository's
[GitHub issues](https://github.com/kbaghini/node-idb/issues).

## License

MIT
