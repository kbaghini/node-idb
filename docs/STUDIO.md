# node-idb Studio guide

Studio is the local browser interface included with `node-idb`. One install
provides both entry points:

```js
import { createIdb } from "node-idb";
import { startStudio } from "node-idb/studio";
```

It is best for development, data review, query learning, diagnostics, and
deliberate local corrections. It is not a remotely hosted, multi-user database
administration service.

## Contents

- [Quick start](#quick-start)
- [First guided tour](#first-guided-tour)
- [How database discovery works](#how-database-discovery-works)
- [Studio areas](#studio-areas)
- [Query tutorial](#query-tutorial)
- [Structure tutorial](#structure-tutorial)
- [Write mode](#write-mode)
- [Phonebook tutorial](#phonebook-tutorial)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Programmatic lifecycle](#programmatic-lifecycle)

## Quick start

Install the one package:

```bash
npm install node-idb
```

Create `studio.js`:

```js
import { startStudio } from "node-idb/studio";

const studio = await startStudio({
  rootPath: "./data",
  port: 0,
});

console.log(studio.url);
```

Run it, keep the process open, and open the **complete** printed URL:

```bash
node studio.js
```

`port: 0` asks the operating system for a free port. Studio binds only to
`127.0.0.1`, uses a fresh token for every launch, and is read-only by default.

For a ready-made version that also creates sample data:

```bash
node examples/00-beginner-studio.js
```

## First guided tour

After opening the printed URL:

1. Choose a database and collection in the left navigator.
2. In **Browse**, page through records and expand nested values.
3. In **Structure**, switch between Tree and List to inspect observed paths,
   types, optional fields, coverage, and predicate-index status.
4. In **Query**, use the visual builder or enter a canonical `SELECT`.
5. In **Diagnostics**, review storage size, cache state, indexes, and integrity.
6. If the launcher explicitly enabled writes, use **Write** for one deliberate
   insert, update, replace, or confirmed delete.

The browser tab does not own the server. Closing the tab does not stop Studio;
stop its Node.js process or call `await studio.close()`.

## How database discovery works

`rootPath` is a trusted top folder. Studio discovers a database stored directly
in that folder and databases stored in its immediate child folders:

```text
data/
  db-collection-settings.sqlite       # database at the root
  db-blobs-settings.sqlite
  development/                        # immediate child database
    db-collection-people.sqlite
    db-blobs-people.sqlite
  production/                         # another immediate child database
    db-collection-people.sqlite
    db-blobs-people.sqlite
```

It does not recursively scan grandchildren and does not create databases from
empty folders. Create at least one collection through the core API, then use
Studio's refresh action:

```js
const database = createIdb({ storagePath: "./data/development" });
await database.execute("INSERT INTO settings", { theme: "dark" });
await database.close();
```

Added, removed, or renamed immediate child folders appear after refresh.

## Studio areas

| Area | Use it for |
| --- | --- |
| Browse | Bounded paging and expandable views of typed, nested documents |
| Structure | Tree/list inspection of observed field paths, types, coverage, optionality, and indexes |
| Query | Canonical `SELECT`, separate parameters, and a schema-driven query builder |
| Write | Explicit insert, deep-merge update, complete replacement, and confirmed deletion |
| Diagnostics | Collection schemas, automatic-index state, storage statistics, cache state, integrity, `ANALYZE`, and index optimization |

Studio preserves `Date`, `BigInt`, binary data, arrays, `undefined` array
entries, and nested objects through its typed transport. The write editor uses
Extended JSON markers for values JSON cannot represent:

```json
{
  "createdAt": { "$nodeIdb": { "type": "date", "value": "2026-07-21T10:00:00.000Z" } },
  "largeNumber": { "$nodeIdb": { "type": "bigint", "value": "9007199254740993" } },
  "bytes": { "$nodeIdb": { "type": "binary", "value": "AAECAw==" } }
}
```

## Query tutorial

Studio accepts bounded, single-collection, canonical `SELECT` queries. Start
with complete documents:

```sql
SELECT * FROM contacts ORDER BY displayName LIMIT 25
```

Project nested fields while keeping object and array values structured:

```sql
SELECT displayName, address, phones, companyRef
FROM contacts
WHERE active = ?
ORDER BY displayName
LIMIT 50
```

Use the separate Parameters editor:

```json
[true]
```

Aggregate scalar values:

```sql
SELECT status, COUNT(*) AS total
FROM contacts
GROUP BY status
ORDER BY total DESC
```

Studio intentionally rejects `JOIN`, arbitrary SQL, mutations in the query
editor, and collections not already present in the selected database. Use
application-level references and two bounded queries for relationships.

## Structure tutorial

The Structure area shows the same observed metadata available through the core
`database.structure()` API. It describes data already present; it is not an
enforced validation schema.

- **Tree** is best for understanding nested objects at a glance.
- **List** is best for comparing exact paths, coverage, types, and indexes.
- A field with collection coverage below 100% is absent from some documents.
- Multiple types mean the observed data is heterogeneous at that path.
- Array contents remain atomic; node-idb does not infer element schemas.

The programmatic equivalent is:

```js
const full = await database.structure("contacts");
const address = await database.structure("contacts", { path: "address" });
```

## Write mode

Enable writes only when starting the server:

```js
const studio = await startStudio({
  rootPath: "./data",
  port: 0,
  writable: true,
});
```

Write mode adds narrow validated endpoints and UI forms. It does not turn the
query editor into a command console. Back up important data first, reload a
document before editing when another process may change it, and use application
migrations or scripts for bulk changes.

Do not enable writes merely to browse, query, inspect structure, or view
diagnostics—read-only mode already supports those tasks.

## Phonebook tutorial

The packaged Phonebook project is the recommended complete Studio exercise. It
generates five collections and more than 12,000 deterministic synthetic
documents with one-to-many and many-to-many application-level references:

```bash
node examples/phonebook-studio/index.js --port=0
```

Use a smaller dataset for a quick code review:

```bash
node examples/phonebook-studio/index.js --companies=8 --groups=5 --contacts=100 --memberships=180 --interactions=400 --reseed --port=0
```

Continue with the hands-on
[Phonebook Studio tutorial](../examples/phonebook-studio/README.md), which
includes the relationship model, UI tour, query recipes, index exercises,
write exercise, code map, and safe rerun rules.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `rootPath` | required | Trusted top-level database folder; relative paths resolve immediately |
| `port` | `4177` | Loopback port; `0` selects a free port |
| `writable` | `false` | Explicitly enables mutation and maintenance endpoints |
| `maxRows` | `500` | Maximum rows in one query response or document page; maximum `10_000` |
| `bodyLimitBytes` | `2 MiB` | Maximum JSON request body; maximum `64 MiB` |
| `queryTimeoutMs` | `10_000` | Database operation deadline; maximum ten minutes |

The returned handle exposes `url`, `host`, the actual `port`, resolved
`rootPath`, `writable`, `closed`, `refresh()`, and `close()`.

## Security model

Studio combines loopback-only binding, a random 256-bit token for each launch,
strict host/origin checks, same-origin requests, a restrictive Content Security
Policy, bounded bodies and responses, opaque catalog IDs, sanitized errors, and
read-only-by-default database engines.

Treat the complete printed URL like a short-lived password. Do not expose
Studio through a reverse proxy, tunnel, port forwarding, public hostname, or
published container port. Studio has no users, roles, TLS termination, tenant
isolation, or remote-administration security model.

## Troubleshooting

### “Studio is unavailable — No Studio token was found”

Open the complete URL printed by `startStudio()`, including the `#token=...`
fragment. A copied URL without its fragment cannot authenticate. Restarting
Studio creates a new token, so an older URL stops working.

### “Connection failed”

Keep the Node.js launcher running. Confirm the browser uses the exact printed
host and port. If the chosen port is occupied, use `port: 0`. Refreshing an old
browser tab after restarting the launcher will not work because the token and
possibly the port changed.

### Studio opens but no databases appear

Confirm `rootPath` contains node-idb files directly or in an immediate child
folder. Empty folders and deeper descendants are ignored. Create at least one
collection with the core API and press Refresh.

### Studio says read only

That is the safe default, not a connection failure. Restart the launcher with
`writable: true` only if you intentionally need write forms.

### The browser tab closed but the port is still occupied

Stop the terminal process with Ctrl+C or call `await studio.close()`. If a
previous Node process is still running, terminate that specific process before
reusing its port.

## Programmatic lifecycle

```js
import { startStudio } from "node-idb/studio";

const studio = await startStudio({ rootPath: "./data", port: 0 });

console.log(studio.url);
console.log(studio.host, studio.port, studio.writable);

await studio.refresh();
await studio.close();
await studio.close(); // idempotent
```

Importing `node-idb/studio` never starts a server. Only `startStudio()` does.
The server owns database engines it opens and closes them when its handle is
closed.
