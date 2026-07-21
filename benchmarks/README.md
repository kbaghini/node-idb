# node-idb benchmarks

This directory contains a deterministic benchmark harness for measuring changes
to node-idb. It exercises five separate phases:

1. batched document insertion;
2. indexed point queries;
3. ordered range queries;
4. key-selected document updates; and
5. queries that cycle through enough collections to exercise the open-store
   cache.

The generated documents and every query target are derived from a fixed seed.
The timings will still vary with hardware, operating-system caching, background
activity, Node.js, SQLite, and storage, so compare several runs on the same idle
machine rather than treating one result as a universal score.

## Quick start

From the repository root:

```sh
node benchmarks/run.js
```

The default `quick` preset is intentionally small enough for a development
smoke test. Larger repeatable workloads are available with:

```sh
node benchmarks/run.js --preset standard
node benchmarks/run.js --preset stress
```

Run `node benchmarks/run.js --help` for every override. Any preset value can be
changed independently, for example:

```sh
node benchmarks/run.js --preset standard \
  --documents 10000 \
  --point-queries 5000 \
  --range-queries 1000 \
  --updates 2500 \
  --seed 12345
```

PowerShell accepts the same command on one line, or with its backtick line
continuation character instead of `\`.

## Comparing database policies

The benchmark exposes the high-level performance controls intended for normal
applications:

```sh
node benchmarks/run.js --field-indexes auto --max-open-collections 8
node benchmarks/run.js --field-indexes all --max-open-collections 32
node benchmarks/run.js --field-indexes focused --max-open-collections 8
node benchmarks/run.js --field-indexes none --max-open-collections 4
node benchmarks/run.js --durability strict
```

`--field-indexes focused` is the benchmark default. It indexes `key` for every
collection and `ordinal` for the main benchmark collection, which are exactly
the fields used by its predicates. `auto` measures adaptive learning during the
workload; use a fresh storage directory for each run so earlier observations do
not affect the comparison. `all` measures the write and storage cost of indexing
every field. `none` measures minimal indexing, including the resulting query-scan
cost.

For a disk-backed cache-churn phase, choose more
`--cache-churn-collections` than `--max-open-collections` to force eviction and
reopening. Choosing a larger cache provides a useful control run where all test
collections can remain open. `:memory:` runs still query many collections, but
cannot exercise LRU eviction because closing an in-memory collection would
discard it; JSON therefore reports `maxOpenCollections` as `null` in that mode.

These options are part of the `0.2` instance-scoped API and are included in the
published package.

## JSON reports

Use JSON on standard output for CI or another analysis tool:

```sh
node benchmarks/run.js --preset standard --json > benchmark.json
```

Or keep the human table and write a complete JSON report at the same time:

```sh
node benchmarks/run.js --output results/standard.json
```

Each report includes the exact effective workload, seed, database policy, package and
Node.js, V8, libuv, N-API, and SQLite versions, operating system, architecture,
CPU model, logical CPU count, memory size, storage mode, wall-clock duration,
and per-phase results. Each
phase reports throughput plus minimum, mean, p50, p95, p99, and maximum API-call
latencies. If a requested range width exceeds the document count, the report
preserves it as `requestedRangeWidth` and records the effective `rangeWidth`.
Insert latency samples represent batches; insert throughput is still
reported in documents per second.

Document generation, query selection, point-query warmups, and cache-churn
collection setup happen outside their corresponding phase timings. Correctness
checks remain enabled during every run so a fast but incorrect query fails the
benchmark instead of producing a misleading score.

## Storage safety

By default, the runner creates a uniquely named directory directly under the
operating system's temporary directory. It removes only that exact directory
after the database closes. Use `--keep` to retain it for inspection.

You can select persistent storage explicitly:

```sh
node benchmarks/run.js --storage-path D:\benchmarks\node-idb-run-01
```

A user-supplied path must either not exist or be an empty directory. It is
claimed with an atomic marker so concurrent benchmark processes cannot both use
it. The directory is always retained, even if the benchmark fails; only the
runner's marker is removed during an orderly shutdown. The runner never deletes
the supplied directory and never intentionally mixes benchmark records into an
existing database. After a process crash, inspect the directory before manually
removing a stale `.node-idb-benchmark.lock`. Exact `:memory:` is also supported
for measurements that intentionally exclude filesystem I/O.

## Producing meaningful comparisons

- Use the same commit, Node.js version, command line, seed, and storage class.
- Close other disk- and CPU-intensive programs and run each configuration
  several times.
- Discard or explain obvious environmental outliers instead of averaging them
  silently.
- Compare full JSON metadata along with timings; do not compare only throughput.
- Benchmark `strict` durability when that is the production setting. The faster
  `balanced` preset is not a substitute for the durability policy an
  application actually needs.
- Use a dedicated empty directory on the same filesystem as production when
  filesystem behavior is important.

The harness is a controlled regression and trade-off tool, not a claim about a
maximum database size or a substitute for load testing the application's real
documents, query shapes, concurrency, and failure behavior.
