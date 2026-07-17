# node-idb

`node-idb` is a server-side SQLite document store for Node.js. It combines a
simple document API with familiar SQL-style queries, typed values, nested
documents, deterministic aliases, indexed predicates, and transactional
concurrency.

It is useful when you want an embedded database with document-shaped data,
without running a separate database server. Data is stored locally in SQLite
files and remains inspectable with standard SQLite tools.

## Install

```bash
npm install node-idb
```

Node.js 20.19 or newer is required.

## Examples

The package includes a progression from a first insert to concurrent writers
and legacy compatibility. Run any example from the package root with
`node examples/<file>.js`.

See the complete guide: [examples/README.md](examples/README.md).

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
inside an array is preserved. Circular references, non-finite numbers, invalid
dates, unsupported class instances, prototype-sensitive keys, literal dots,
and nesting deeper than 128 levels are rejected before commit.
Blob-backed rows whose external payload is missing are reported as an integrity
error rather than silently decoded as empty data.

## Storage, migration, and durability

The default file layout is unchanged:

```text
idbs/
  <project>/
    db-collection-<collection>.sqlite
    db-blobs-<collection>.sqlite
```

Legacy populated v0/v2 files are opened and upgraded in place; document IDs and
the separate blob files are retained. Project and collection storage names may
contain letters, numbers, underscores, and hyphens. A project such as
`-system-` remains valid. `mem:<name>` creates non-persistent collection stores.

Main and blob databases are attached to one SQLite connection. Disk-backed
stores use rollback journals with `synchronous=FULL`, which allows SQLite's
multi-file super-journal to commit both files atomically. Writes use
`BEGIN IMMEDIATE`, a 10-second busy timeout, an in-process queue, and a catalog
refresh after acquiring the write lock. Read/modify/write operations are one
transaction, and multi-query document reads use a stable snapshot.

Common scalar equality, range, `IN`, `BETWEEN`, `LIKE`, and `GLOB` predicates
use per-field indexes. Blob-backed long text, array, and binary values retain a
semantically equivalent fallback. Wide result reads are chunked below SQLite's
bind and compound-query limits.

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
