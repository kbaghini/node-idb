# Contributing to node-idb

Thank you for helping improve `node-idb`. Changes should preserve data safety,
legacy compatibility, deterministic query behavior, and a small public API.

## Before opening an issue

- Search existing issues and releases.
- Use the bug-report form for reproducible defects.
- Use the feature-request form for proposed behavior.
- Follow [SECURITY.md](SECURITY.md) for vulnerabilities; do not disclose them
  in a public issue.

## Development setup

Requirements:

- Node.js 20.19 or newer
- npm
- A local filesystem suitable for SQLite tests

```bash
git clone https://github.com/kbaghini/node-idb.git
cd node-idb
npm ci
npm test
```

## Making a change

1. Create a focused branch from the default branch.
2. Keep public behavior backward-compatible unless the change is intentionally
   scheduled for a breaking release.
3. Add or update tests for every observable behavior change.
4. Update the README, examples, declarations, and changelog when applicable.
5. Run the complete validation commands before opening a pull request.

```bash
npm test
npm run pack:check
```

## Design expectations

- Bind application values as parameters; do not interpolate them into SQL.
- Keep main/blob mutations atomic and preserve rollback-journal durability.
- Preserve support for legacy v0/v2 files unless a documented migration says
  otherwise.
- Reject ambiguous or lossy input instead of guessing.
- Keep aliases and wildcard results deterministic.
- Avoid exposing internal tables as public API.
- Document performance implications and operational limits honestly.

## Tests

The test suite covers public API behavior, SQL compilation, legacy migration,
typed values, cross-engine concurrency, corruption detection, wide reads, and
index usage. Use temporary storage for new tests and close all engines during
cleanup.

## Pull requests

Keep pull requests narrow enough to review. Explain:

- What changed
- Why it changed
- Compatibility or migration effects
- Storage and performance effects
- How it was tested

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.

## Releases

Maintainers publish by pushing a version tag such as `v0.1.1`. The release
workflow verifies that the tag matches `package.json`, runs the complete test
and package checks, publishes through npm trusted publishing, and creates the
matching GitHub Release. Never move or reuse a published version tag.
