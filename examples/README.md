# Examples

Start with one of these two tiny examples:

```bash
node examples/00-beginner.js
node examples/00-beginner-studio.js
```

The first demonstrates the complete database lifecycle in a few lines. The
second seeds one collection and prints a token-protected Studio URL. Core and
Studio are included in the same `node-idb` package.

Run these examples from the package root after installing dependencies:

```bash
npm install
node examples/01-quick-start.js
```

Each example writes only below `./.example-data/`. Delete that directory when
you want to start the examples from an empty database.

| File | What it demonstrates |
| --- | --- |
| [`00-beginner.js`](./00-beginner.js) | The smallest complete core example: create, insert, select, and close |
| [`00-beginner-studio.js`](./00-beginner-studio.js) | The smallest Studio example: seed, start on a free port, browse, and stop |
| [`01-quick-start.js`](./01-quick-start.js) | Create one database instance, insert, select complete documents, and close |
| [`02-crud-and-mutations.js`](./02-crud-and-mutations.js) | Merge updates, formula updates, upsert, replace, and delete |
| [`03-sql-queries-and-aliases.js`](./03-sql-queries-and-aliases.js) | Structured object/array projections, filters, aliases, wildcards, grouping, and pagination |
| [`04-types-and-binary-data.js`](./04-types-and-binary-data.js) | Date, BigInt, Buffer, arrays, long text, and nested values |
| [`05-callback-compatibility.js`](./05-callback-compatibility.js) | Promise envelopes and migration from deprecated callback overloads |
| [`06-multiple-projects.js`](./06-multiple-projects.js) | Separate database instances for development and production |
| [`07-raw-compatibility-read.js`](./07-raw-compatibility-read.js) | Canonical read-only physical SQLite diagnostics |
| [`08-concurrent-writers.js`](./08-concurrent-writers.js) | Two engines simulating separate processes writing to one path |
| [`09-backup-and-readonly.js`](./09-backup-and-readonly.js) | Verified backup results, the recognition manifest, and genuine read-only access |
| [`10-index-policy-and-cache.js`](./10-index-policy-and-cache.js) | Focused field-index rules and transparent collection-cache eviction |
| [`11-streaming-and-operations.js`](./11-streaming-and-operations.js) | Backpressured reads, deadlines, diagnostics, statistics, ANALYZE, and VACUUM |
| [`12-verify-restore-and-inspect.js`](./12-verify-restore-and-inspect.js) | Standalone backup verification, guarded restore, and offline inspection |
| [`13-automatic-indexing.js`](./13-automatic-indexing.js) | Adaptive index learning, hard rules, diagnostics, and dry-run evaluation |
| [`14-local-studio.js`](./14-local-studio.js) | Seed two documents and start the token-protected local browser Studio |
| [`15-collection-structure.js`](./15-collection-structure.js) | Inspect an immutable observed collection tree or one nested sub-field |
| [`phonebook-studio/`](./phonebook-studio/) | A reviewable multi-collection Phonebook project with 12,000+ related documents and a Studio launcher |

The examples intentionally use the public `node-idb` and `node-idb/studio`
imports. Both entry points come from one npm package. Node resolves that
package self-reference from this checkout after `npm install`; no relative
import rewrite is needed. If you copy a file outside the package, install
`node-idb` there as a dependency.

Every call to `createIdb()` owns one database directory. Prefer one shared
instance per resolved storage path inside a process. Create multiple instances
with different paths when an application needs separate databases.

The beginner Studio example and examples 09 through 15 demonstrate `0.2` APIs.
Backup destinations are
replaced only when they already contain a recognized node-idb manifest. The
field-index policy in example 10 is persisted into each opened collection;
changing it on a later run performs index reconciliation rather than changing
query semantics. Example 13 uses deliberately low learning thresholds so the
adaptive behavior is visible with a tiny sample; normal applications should use
the balanced defaults. Example 14 keeps running until interrupted; its printed
URL contains a short-lived Studio access token, so treat that URL as a password.
The Phonebook project expands that minimal launcher into five data collections,
application-level `object_id` references, deterministic batched seeding, pinned
relationship indexes, and thousands of records for paging and diagnostics.
