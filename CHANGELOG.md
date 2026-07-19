# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## 0.1.0 - 2026-07-17

- Initial public release.
- Promise and callback-compatible APIs.
- SQLite-backed typed document storage.
- Legacy IDB storage and SQL compatibility.
- Transactional multi-process writes and stable document snapshots.
- Deterministic nested aliases and wildcard projections.

[Unreleased]: https://github.com/kbaghini/node-idb/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kbaghini/node-idb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kbaghini/node-idb/releases/tag/v0.1.0
