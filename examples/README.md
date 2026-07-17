# Examples

Run these examples from the package root after installing dependencies:

```bash
npm install
node examples/01-quick-start.js
```

Each example writes only below `./.example-data/`. Delete that directory when
you want to start the examples from an empty database.

| File | What it demonstrates |
| --- | --- |
| [`01-quick-start.js`](./01-quick-start.js) | Create an engine, insert, read, and close |
| [`02-crud-and-mutations.js`](./02-crud-and-mutations.js) | Merge updates, formula updates, upsert, replace, and delete |
| [`03-sql-queries-and-aliases.js`](./03-sql-queries-and-aliases.js) | Filters, parameters, nested aliases, wildcards, grouping, and pagination |
| [`04-types-and-binary-data.js`](./04-types-and-binary-data.js) | Date, BigInt, Buffer, arrays, long text, and nested values |
| [`05-callback-compatibility.js`](./05-callback-compatibility.js) | Promise envelopes and legacy callback overloads |
| [`06-multiple-projects.js`](./06-multiple-projects.js) | Project isolation and separate environments |
| [`07-raw-compatibility-read.js`](./07-raw-compatibility-read.js) | Read-only physical SQLite diagnostics |
| [`08-concurrent-writers.js`](./08-concurrent-writers.js) | Independent engines writing safely to one project |

The examples intentionally use the public `node-idb` import. When experimenting
inside a checkout without installing the package, replace it with
`../src/index.js`.
