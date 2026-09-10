<p align="center"><img alt="node-idb — Your documents. Your database. SQL-style queries, local SQLite storage and a built-in browser Studio." src="https://raw.githubusercontent.com/kbaghini/node-idb/master/docs/assets/node-idb-overview.svg" width="100%"></p>

<h1 align="center">node-idb</h1>

<p align="center"><strong>A document database that lives with your Node.js app.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/node-idb">On npm</a> ·
  Node.js 20.19+ ·
  <a href="https://github.com/kbaghini/node-idb/blob/master/LICENSE">MIT licensed</a>
</p>

Store nested JavaScript objects, query them with **SQL-style syntax**, and
explore them in **Studio**. Powered by local SQLite files, `node-idb` runs
inside your application, with no separate database service to deploy.

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#open-studio">Studio</a> ·
  <a href="https://github.com/kbaghini/node-idb/tree/master/examples">Examples</a> ·
  <a href="https://github.com/kbaghini/node-idb/blob/master/docs/GUIDE.md">Documentation</a>
</p>

## Why node-idb?

- **Documents with their types intact.** Store nested objects, arrays, `Date`,
  `BigInt`, and binary data; recover their native types in full-document reads.
- **Familiar queries.** Filter nested fields, select only what you need, sort,
  group, and aggregate using parameters. TypeScript declarations are included.
- **Less setup.** Collections grow from your writes. Adaptive indexes learn
  from query activity; explicit rules let you tune known workloads.
- **Built-in tools.** Browse, edit, compare, and review data in Studio. Preview
  imports, share review packages, and create verified backups.
- **Practical performance.** Bounded query caches, streaming reads and cursor
  pagination, with [reproducible benchmarks](https://github.com/kbaghini/node-idb/tree/master/benchmarks).

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

Open the complete printed URL and select `my-app` → `people`.

| In Studio | You can… |
| --- | --- |
| Browse & structure | Page through documents and explore their observed fields and types. |
| Query | Build or write `SELECT` queries, expand results, and cancel running reads. |
| Data tools | Export data, preview imports, compare collections, and share review packages. |
| Diagnostics & recovery | Inspect indexes and storage; opt in to managed backups and restore. |

Studio binds to `127.0.0.1`, protects access with a launch token, and starts
**read-only**. Explicitly enable `writable: true` for editing. Keep the process
running while using Studio; stop it with Ctrl+C.

**Inside your own web app:** optional Embed mode connects Studio to your
application's login and per-user database permissions, with an iframe-friendly
layout. Follow the [server integration guide](https://github.com/kbaghini/node-idb/blob/master/docs/EMBED.md).

[Studio guide](https://github.com/kbaghini/node-idb/blob/master/docs/STUDIO.md)
· [Embed in your app](https://github.com/kbaghini/node-idb/blob/master/docs/EMBED.md)
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
| Fast storefront lists and detail views | [Product cards](https://github.com/kbaghini/node-idb/blob/master/examples/18-product-cards.js) · [Cursor pages](https://github.com/kbaghini/node-idb/blob/master/examples/17-cursor-pagination.js) |
| Changes between versions | [Changelog](https://github.com/kbaghini/node-idb/blob/master/CHANGELOG.md) |

Tested on **Windows and Linux with Node.js 20.19, 22, and 24**, including fresh
package installation, the core API, Studio, CLI, and TypeScript declarations.

[Report an issue](https://github.com/kbaghini/node-idb/issues)
· [Contribute](https://github.com/kbaghini/node-idb/blob/master/CONTRIBUTING.md)
· [Security policy](https://github.com/kbaghini/node-idb/blob/master/SECURITY.md)
· [MIT license](https://github.com/kbaghini/node-idb/blob/master/LICENSE)
