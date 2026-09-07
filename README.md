<h1 align="center">node-idb</h1>

<p align="center"><strong>JavaScript documents. SQL-style queries. Local SQLite storage.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/node-idb"><img alt="npm version" src="https://img.shields.io/npm/v/node-idb.svg?color=cb3837"></a>
  <a href="https://github.com/kbaghini/node-idb/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kbaghini/node-idb/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/node-idb"><img alt="Node.js version" src="https://img.shields.io/node/v/node-idb.svg?color=339933"></a>
  <a href="https://github.com/kbaghini/node-idb/blob/master/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2563eb.svg"></a>
</p>

`node-idb` is an embedded document store for **Node.js**. Save nested JavaScript
objects, query them with familiar SQL-style syntax, and explore your data in the
included browser **Studio**. Everything runs beside your application, with no
separate database server to manage.

<p align="center"><img alt="One package: a document API and browser Studio over local SQLite storage" src="https://raw.githubusercontent.com/kbaghini/node-idb/master/docs/assets/node-idb-overview.svg" width="820"></p>

## Why node-idb?

- **Keep your types.** Round-trip nested objects, arrays, `Date`, `BigInt`, and
  binary data without manual JSON conversions.
- **Query your documents.** Filter nested fields, select projections, sort,
  group, and aggregate with parameterized SQL-style queries.
- **Start without schema setup.** Collections and field structures are created
  as you write; adaptive indexes learn from queries within a bounded budget.
- **Write atomically.** Each mutation commits its document and binary values
  together. Stream query results in batches and create verified backups.
- **See what you store.** Browse documents, inspect their structure, run queries,
  and review diagnostics in Studio. TypeScript declarations are included.

## Quick start

Requires **Node.js 20.19+**. Use ESM (`.mjs`, or `"type": "module"` in your
`package.json`). SQLite runs through the native `sqlite3` dependency.

```bash
npm install node-idb
```

Save this as `app.mjs`, then run `node app.mjs`:

```js
import { createIdb } from "node-idb";

const db = createIdb({ storagePath: "./data/my-app" });

try {
  await db.execute("INSERT INTO people", {
    name: "Ada",
    contact: { email: "ada@example.test" },
    tags: ["engineer", "author"],
    joinedAt: new Date("2026-01-01T00:00:00Z"),
  });

  const people = await db.execute(
    "SELECT * FROM people WHERE contact.email = ?",
    ["ada@example.test"],
  );

  console.log(people[0].name);                     // Ada
  console.log(people[0].joinedAt instanceof Date); // true
} finally {
  await db.close();
}
```

The data persists in `./data/my-app`. Each run inserts another document.
For disposable storage, use `storagePath: ":memory:"`.

[CRUD and mutations](https://github.com/kbaghini/node-idb/blob/master/examples/02-crud-and-mutations.js)
· [Queries and projections](https://github.com/kbaghini/node-idb/blob/master/examples/03-sql-queries-and-aliases.js)
· [Typed values](https://github.com/kbaghini/node-idb/blob/master/examples/04-types-and-binary-data.js)

## Open Studio

Studio comes in the **same npm package**. After running the example above,
save this as `studio.mjs` and run `node studio.mjs`:

```js
import { startStudio } from "node-idb/studio";

const studio = await startStudio({ rootPath: "./data", port: 0 });
console.log(studio.url);
```

Open the complete printed URL and select `my-app`, then `people`. Browse typed
values, inspect document structure, and run `SELECT` queries with expandable
results and cancellation.

Studio binds to `127.0.0.1`, protects access with a launch token, and starts
**read-only**. Explicitly enable `writable: true` for editing. Keep the process
running while using Studio; stop it with Ctrl+C.

[Studio guide](https://github.com/kbaghini/node-idb/blob/master/docs/STUDIO.md)
· [Phonebook demo with 12,000+ documents](https://github.com/kbaghini/node-idb/tree/master/examples/phonebook-studio)

## Is it a fit?

A good fit for **local services, internal tools, content catalogs, caches, and
single-host APIs** with reasonably stable document shapes and modest write
concurrency.

Data belongs on a **local filesystem**. SQLite serializes writers per collection;
node-idb does not provide replication or distributed storage. Its query language
is a SQL-style subset: no cross-collection joins or transactions spanning multiple
API calls. Arrays are stored as whole values, not individually queryable elements.

For workload sizing, large documents, dynamic keys, and deployment decisions,
read the [technical guide](https://github.com/kbaghini/node-idb/blob/master/docs/GUIDE.md#who-should-use-it).
The package is currently **0.x**; review release notes and test your workload
before production upgrades.

## Learn more

| Looking for | On GitHub |
| --- | --- |
| API options and methods | [API reference](https://github.com/kbaghini/node-idb/blob/master/docs/GUIDE.md#public-api) |
| Query syntax and return values | [Statement reference](https://github.com/kbaghini/node-idb/blob/master/docs/GUIDE.md#statements-and-results) |
| Runnable examples | [Example collection](https://github.com/kbaghini/node-idb/tree/master/examples) |
| Backups, restore, and read-only access | [Backup and recovery](https://github.com/kbaghini/node-idb/blob/master/docs/GUIDE.md#backup-and-recovery) |
| Streaming, cancellation, and cache tuning | [Performance controls](https://github.com/kbaghini/node-idb/blob/master/docs/GUIDE.md#cancellation-streaming-and-memory-controls) |
| Reproducible performance measurements | [Benchmark guide](https://github.com/kbaghini/node-idb/blob/master/benchmarks/README.md) |
| Changes between versions | [Changelog](https://github.com/kbaghini/node-idb/blob/master/CHANGELOG.md) |

Tested on **Windows and Linux with Node.js 20.19, 22, and 24**, including fresh
package installation, the core API, Studio, CLI, and TypeScript declarations.

[Report an issue](https://github.com/kbaghini/node-idb/issues)
· [Contribute](https://github.com/kbaghini/node-idb/blob/master/CONTRIBUTING.md)
· [Security policy](https://github.com/kbaghini/node-idb/blob/master/SECURITY.md)
· [MIT license](https://github.com/kbaghini/node-idb/blob/master/LICENSE)
