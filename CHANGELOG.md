# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-21

### Changed

- Made every engine instance own one database directory. `execute()` and
  `run()` now receive a statement and optional parameters without a project
  argument.
- Made `storagePath` required and resolve relative paths when `createIdb()` is
  called, preventing later working-directory changes from redirecting an open
  engine.
- Made `SELECT` the one canonical read command. A lone `SELECT *` reconstructs
  complete documents, direct object paths are reconstructed in mixed
  projections with their nested native values, and arrays remain atomic typed
  values. `FIND` is retained only as a thin compatibility rewrite through
  `0.x`; both paths share the same compiler and document reader.
- Reduced mutations and diagnostics to one canonical spelling per operation:
  `INSERT INTO`, `UPDATE`, `UPSERT INTO`, `REPLACE INTO`, `UNSET ... FROM`,
  `DELETE FROM`, and `QUERY ON`.
- Required `WHERE` for `UPSERT INTO` and `REPLACE INTO` to prevent accidental
  collection-wide merge or replacement.
- Restricted complete-document and mutation selectors from using `GROUP BY`
  or `HAVING`; grouped and aggregate results belong to `SELECT`.
- Made `close()` terminal. It waits for active operations and a closed engine
  cannot be reused; construct a new instance to reopen its storage path.
- Deprecated only the Node-style callback overloads of `run()`. They emit one
  process-level `NODE_IDB_RUN_CALLBACK` warning and remain supported throughout
  `0.x`; `execute()` and Promise-based `run()` are not deprecated.
- Advanced writable collections to schema v5, persisting normalized manual or
  adaptive `fieldIndexes` policies, bounded query observations, and automatic
  index decisions.

### Added

- Shipped the core API and local browser Studio together in one `node-idb`
  package and release lifecycle, using the documented `node-idb` and
  `node-idb/studio` entry points. Added a packaging regression check, dedicated
  Studio manual, visual overview, beginner core/Studio examples, and an
  expanded hands-on Phonebook tutorial.
- Added `structure(collection, options?)` for immutable observed collection or
  sub-field trees with exact logical type counts, collection/parent coverage,
  optionality, nesting depth, and actual predicate-index status. The same core
  contract now powers detailed Studio structure inspection.
- Added the optional `node-idb/studio` local web interface with loopback-only
  binding, per-launch bearer tokens, read-only-by-default access, explicit
  write enablement, bounded existing-collection canonical `SELECT` queries,
  typed document editing,
  diagnostics, maintenance controls, and root-plus-immediate-child database
  discovery.
- Added a deterministic Phonebook Studio sample with five related collections,
  more than 12,000 documents, returned-ID relationship construction, pinned
  relationship indexes, exclusive seeder locking, ownership state, and
  explicit guarded reseeding.
- Added the exact `:memory:` storage path for isolated non-persistent engines.
- Added `busyTimeoutMs`, defaulting to 10,000 milliseconds.
- Added `durability: "strict" | "balanced"`. Strict durability remains the
  default; balanced durability uses SQLite `synchronous=NORMAL` for workloads
  that explicitly accept weaker power-loss guarantees.
- Added validation for unknown factory options and database schema versions
  newer than the installed package supports.
- Added migration-focused errors for removed statement spellings and old
  project arguments.
- Added genuine `mode: "readonly"` storage access for current schema-v5 disk
  collections. It permits document reads, projections, diagnostics, and
  backups without creating, migrating, reconciling, or otherwise mutating
  source files.
- Added `maxOpenCollections`, defaulting to `16`, with safe least-recently-used
  eviction of idle disk collection stores. Memory engines retain their
  connections because eviction would erase data and therefore reject an
  explicit cap.
- Added `fieldIndexes: "all" | "none" | policy`, including ordered exact-path
  and dot-segment-pattern rules, so applications can balance predicate read
  speed against index storage and write amplification.
- Added balanced adaptive indexing as the default for new storage through
  `fieldIndexes: "auto"`, with conservative/balanced/aggressive presets,
  canonical alias-safe observations, decaying bounded telemetry, index budgets,
  cooldowns, hard rule overrides, persistent decisions, multi-process schema
  coordination, and conservative removal of auto-managed indexes only.
- Added `optimizeIndexes()` for immediate or dry-run evaluation and automatic
  bounded `PRAGMA optimize` maintenance after schema changes, periodically,
  and during collection shutdown.
- Added `backup()` for staged, integrity-checked, SHA-256-manifested disk
  snapshots. It supports selected collections, cancellation, guarded overwrite
  of recognized backups, and consistent main/blob pairs with an explicit
  per-collection consistency boundary.
- Added a deterministic benchmark harness and JSON reporting for inserts,
  point/range queries, updates, index policies, durability, and collection-cache
  churn.
- Added compile-time contract tests for path-sensitive memory, read-only, and
  cache option combinations.
- Added cancellation and execution deadlines to `execute()`, including SQLite
  interruption and transaction rollback for cancelled mutations.
- Added `execute(..., { requireMatch: true })` for atomic must-exist
  `UPSERT INTO` and `REPLACE INTO` operations that return an empty result
  instead of inserting after a selector miss.
- Added backpressured `stream()` reads for projected rows and complete
  `SELECT *` documents with stable snapshots and configurable batch sizes.
- Added engine diagnostics, cache-eviction counters, schema/index-policy
  visibility, storage/page statistics, and explicit `analyze()`/`vacuum()`
  maintenance helpers.
- Added standalone `verifyBackup()` and guarded `restoreBackup()` APIs. Restore
  stages and verifies output and replaces only recognized manifested storage.
- Added non-mutating `inspectStorage()` and the `node-idb` inspection,
  verification, restore, and explicit migration CLI.

### Fixed

- Reused numbered text-literal bindings across scalar and blob predicate
  branches, keeping long-text literal filters correct and preventing appended
  streaming pagination parameters from shifting into the predicate.

### Removed

- Removed the automatically created default database and default export;
  engines are created only through the explicit `createIdb()` factory.
- Removed per-command project parameters and project-specific `close()`.
- Removed the `GET` and `COLLECT` read spellings plus duplicate mutation and
  raw-query spellings. `FIND` remains a `0.x` compatibility spelling for
  complete-document `SELECT *` queries.
- Removed field deletion through `DELETE`; use `UNSET` for fields and reserve
  `DELETE FROM` for complete documents.

### Migration

- Replace `FIND collection ...` with `SELECT * FROM collection ...` in new
  application code. Existing `FIND` calls remain functional throughout `0.x`.
- `SELECT *` now returns complete reconstructed documents instead of recursive
  flat columns, and a direct object result path now returns its object instead
  of the physical child count. Use stored-path wildcards such as `profile.*`
  when a flat descendant projection is intentionally required.
- Existing data does not need to be copied or renamed. Point each new engine's
  `storagePath` directly at the old project directory that already contains its
  `db-collection-*` and `db-blobs-*` files, then remove the project argument
  from calls.
- Back up every collection/blob file pair before the first open with `0.2`.
- Open legacy storage once in read/write mode to perform the schema-v5 and
  field-index-policy migration before using `mode: "readonly"`.
- Keep one `fieldIndexes` policy per storage path across all processes. Changing
  it reconciles optional indexes during collection initialization and should be
  treated as an operational schema migration.
- Updated the README and every packaged example for the instance-scoped API,
  canonical statements, explicit lifecycle, memory/read-only modes, backups,
  index and cache controls, durability, cancellation/deadlines, streaming,
  diagnostics, maintenance, verification, restore, inspection, and CLI usage.

## [0.1.1] - 2026-07-19

### Documentation

- Added an executive summary and an explicit adoption decision guide.
- Documented recommended and unsuitable use cases.
- Added practical guidance for document, property, array, binary, batch, and
  collection sizing.
- Documented field-path schema costs, SQLite limits, concurrency boundaries,
  operational limitations, backup practices, and a production checklist.

### Repository

- Added continuous integration across supported Node.js versions and operating
  systems.
- Added contribution, security, conduct, issue, pull-request, dependency-update,
  and release automation files.
- Added npm trusted-publishing automation with automatic package provenance.

## [0.1.0] - 2026-07-17

- Initial public release.
- Promise and callback-compatible APIs.
- SQLite-backed typed document storage.
- Legacy IDB storage and SQL compatibility.
- Transactional multi-process writes and stable document snapshots.
- Deterministic nested aliases and wildcard projections.

[Unreleased]: https://github.com/kbaghini/node-idb/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kbaghini/node-idb/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kbaghini/node-idb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kbaghini/node-idb/releases/tag/v0.1.0
