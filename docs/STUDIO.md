# node-idb Studio guide

[Package overview](../README.md) · [Technical guide](GUIDE.md) · [Examples](../examples/README.md)

To place Studio inside your own application's iframe, see the
[Embed integration guide](EMBED.md) and its runnable host-app example.

Studio is the local browser interface included with `node-idb`. One install
provides both entry points:

```js
import { createIdb } from "node-idb";
import { startStudio } from "node-idb/studio";
```

It is best for development, data review, query learning, diagnostics, and
deliberate local corrections. Application hosting requires explicit Embed mode
and the host application's authentication, permissions and HTTPS proxy.

## Cursor pagination

Browse uses cursor pagination for Next/Previous in both Newest and Oldest order.
Changing collection, order, or page size restarts at the first page. The page
summary shows the traversed range, without computing an exact collection total
on every request. Concurrent edits can change page contents; navigation is not
a frozen snapshot. Reload refreshes the current page from its saved boundary.

For custom clients, `POST /api/documents/list` accepts `cursor: null` for the
first page, then the returned numeric `nextCursor` for the next page. Keep
`databaseId`, `collection`, `order` and `limit` consistent while navigating.
`hasMore` comes from one extra ID; cursor responses have `total: null` and
`offset: null`. Do not combine `cursor` and `offset`. Omitting `cursor` retains
the existing offset API and exact total. Existing authentication applies to
both modes; a cursor is only an ID boundary, never an access credential.

See the [storefront example](../examples/17-cursor-pagination.js) and
[100,000-document measurements](../benchmarks/results/2026-09-10-cursor-pages.md).

## Contents

- [Quick start](#quick-start)
- [First guided tour](#first-guided-tour)
- [How database discovery works](#how-database-discovery-works)
- [Studio areas](#studio-areas)
- [Query tutorial](#query-tutorial)
- [Structure tutorial](#structure-tutorial)
- [Write mode](#write-mode)
- [Data tools](#data-tools)
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
7. Use **Data tools** to transfer collections, compare data, review shared
   packages, and manage backups. See the workflow below for its limits.

## Data tools

These local workflows are available in the **Data tools** tab. They do not
require a separate Studio package or an account.

### Export and import

Select a collection, optionally add a review note, and choose **Download
package**. The versioned JSON package preserves dates, big integers, binary
values, and nested data using Studio's tagged transport format. Internal
object IDs are not exported; imported documents receive new IDs.

To import, choose that package or a plain JSON array of objects, then select
**Preview file**. The preview shows the destination, count, package fingerprint,
and up to three expandable samples. Check the review checkbox and choose
**Append documents**. The entire batch is one transaction. Existing documents
are not replaced or merged; importing the same data again with a new preview
will create additional documents. Invalid data rolls back the whole import.

Plain JSON follows the same typed-envelope conventions as the document editor.
An ordinary JSON date string stays a string. Use a Studio export when native
type fidelity matters.

Exports are complete collection snapshots, capped by `maxTransferRows` (default
10,000) and `bodyLimitBytes` (default 2 MiB, with room reserved for metadata).
Oversized exports fail rather than silently omitting rows. Import requests use
the same limits. For larger transfers, configure larger limits deliberately or
use the core streaming API. This browser workflow holds a bounded package in
memory; it is not a streaming file importer.

### Share and review locally

Send a package to a teammate through your usual file-sharing channel. They can
preview it in their own Studio and download a **review receipt** containing its
SHA-256 fingerprint, destination, document count, and whether that session
applied it. Review notes and receipts are ordinary user-editable files, not
signed approvals or an authenticated audit trail. Studio does not transmit
them to teammates automatically.

Preview tickets expire after 10 minutes and can be applied only once to the
reviewed destination. A Studio restart clears tickets. Changing selection or
choosing another file clears the visible review. Read-only sessions can review
and export; applying an import requires `writable: true`.

This first workflow supports append packages. It does not yet apply shared
update/delete plans or provide user roles, remote collaboration, or approval
enforcement.

### Compare collections

Choose the target collection and a unique scalar field such as `sku` or
`contact.email`. Studio reports added, removed, changed, and unchanged records.
Expand differences to inspect before/after values. Object property ordering is
ignored; array ordering and native value types remain significant. Missing or
duplicate keys are rejected to avoid ambiguous matches.

Counts cover both complete collections within the transfer limits; the first
100 differences are displayed. Each collection is read in its own consistent
snapshot, not in a transaction spanning both collections. Results are read-only
and are not a synchronization plan.

### Managed backups

Enable a dedicated backup folder in your launcher:

```js
const studio = await startStudio({
  rootPath: "./data",
  backupPath: "./backups", // Outside rootPath; neither folder may contain the other.
  writable: true,
  port: 0,
});
```

**Back up database** captures the selected database through the core verified
backup API. **Refresh backups** lists managed snapshots; **Verify integrity**
checks their hashes and SQLite integrity. **Restore as new database** verifies
the snapshot and creates a separate `restored-…` database under the root. Refresh
and select it in the navigator to inspect the recovered data. Existing live
databases are never overwritten by this UI.

Creating and verifying backups is allowed in read-only Studio when `backupPath`
is explicitly configured; the source database remains read-only. Restoration
requires writable mode. Backup consistency is per collection, not a single
point in time across all collections. Operations obey `queryTimeoutMs`; increase
it for larger snapshots. Scheduling, retention/deletion, and remote backup
storage are not included.

The browser tab does not own the server. Closing the tab does not stop Studio;
stop its Node.js process or call `await studio.close()`.

Navigate the main tabs with Left/Right arrows, Home, or End while a tab is
focused. On narrow screens, **Hide/Show** in the database header collapses the
navigator to leave more room for documents and tools.

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

Use **Cancel query** to stop a running read. Switching collections or starting
a replacement read also cancels obsolete requests; late responses cannot
overwrite the currently selected collection. Cancellation applies to reads,
not to the Write panel's explicit mutations.

Query rows initially show compact previews. Expand a row to build its typed
detail tree on demand, keeping large result sets responsive. Preview generation
also stops at its visible prefix instead of copying the entire document.

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
| `maxOpenCollections` | `16` | Retained collection connections per discovered database; maximum 10,000 |
| `sqliteCache` | Core defaults | Per-collection `mainKiB`, `blobKiB`, and `mmapBytes` settings; supported in readonly mode |

For example, `sqliteCache: { mainKiB: 4096, blobKiB: 2048, mmapBytes: 0 }`
requests smaller page caches and disables main-file memory mapping. Diagnostics
shows these configured budgets separately from storage size. They are not
measured process memory usage or hard memory caps. `state.version` reports the
installed package version, also available in the mode badge's tooltip.

The returned handle exposes `url`, `host`, the actual `port`, resolved
`rootPath`, `writable`, `closed`, `refresh()`, and `close()`.

## Security model

By default, Studio combines loopback-only binding, a random 256-bit token for each launch,
strict host/origin checks, same-origin requests, a restrictive Content Security
Policy, bounded bodies and responses, opaque catalog IDs, sanitized errors, and
read-only-by-default database engines.

Treat the complete printed local URL like a short-lived password. Do not expose
the default token-based mode through a proxy, tunnel, or published port.
For application hosting, explicitly configure [Embed mode](EMBED.md), which
requires your application's authentication and per-user database grants.
Your host application supplies login, permissions, TLS, and the reverse proxy;
Studio continues to bind only to loopback. Backups remain local operator tools.

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
