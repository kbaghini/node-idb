import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import sqlite3 from 'sqlite3'

import { createIdb } from '../src/index.js'

const backupManifestFilename = '.node-idb-backup.json'

/** @param {import('node:test').TestContext} context @param {string} prefix */
async function temporaryRoot(context, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function waitForManagedIndex(database, collection, fieldPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let diagnostics

  do {
    diagnostics = await database.diagnostics()
    const state = diagnostics.openCollections.find(
      ({ collection: current }) => current === collection,
    )
    if (state?.autoIndexing.managedIndexes.some(({ path: current }) => current === fieldPath)) {
      return diagnostics
    }
    await delay(50)
  } while (Date.now() < deadline)

  assert.fail(`Timed out waiting for the automatic index on ${collection}.${fieldPath}`)
}

/** @param {string} filename */
function openSqlite(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(
      filename,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX,
      (error) => error ? reject(error) : resolve(database),
    )
  })
}

/** @param {import('sqlite3').Database} database @param {string} sql @param {unknown[]} [parameters] */
function sqliteAll(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows) => error ? reject(error) : resolve(rows))
  })
}

/** @param {import('sqlite3').Database} database @param {string} sql @param {unknown[]} [parameters] */
function sqliteGet(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, parameters, (error, row) => error ? reject(error) : resolve(row))
  })
}

/** @param {import('sqlite3').Database} database */
function closeSqlite(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve(undefined))
  })
}

/**
 * Reads the persisted index policy and maps every field path to its SQLite
 * indexes without opening the collection through node-idb (which could
 * intentionally reconcile the policy).
 * @param {string} storagePath
 * @param {string} collection
 */
async function inspectFieldIndexes(storagePath, collection) {
  const identity = collection.toLowerCase()
  const database = /** @type {import('sqlite3').Database} */ (await openSqlite(
    path.join(storagePath, `db-collection-${identity}.sqlite`),
  ))
  try {
    const fields = /** @type {Array<{
     *   id: number,
     *   name: string,
     *   level: number,
     *   parent_field_id: number | null,
     * }>} */ (await sqliteAll(
      database,
      'SELECT id, name, level, parent_field_id FROM tbl_fields ORDER BY level, id',
    ))
    const indexes = /** @type {Array<{ name: string }>} */ (await sqliteAll(
      database,
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_values_%'",
    ))
    const setting = /** @type {{ value: string }} */ (await sqliteGet(
      database,
      "SELECT value FROM tbl_settings WHERE key='field_indexes'",
    ))
    const version = /** @type {{ user_version: number }} */ (await sqliteGet(
      database,
      'PRAGMA user_version',
    ))

    const indexesByName = new Set(indexes.map(({ name }) => name))
    const fieldsById = new Map()
    const byPath = new Map()
    for (const field of fields) {
      const parent = field.parent_field_id == null
        ? null
        : fieldsById.get(Number(field.parent_field_id))
      const fieldPath = !parent
        ? ''
        : parent.parent_field_id == null
          ? String(field.name)
          : `${parent.path}.${String(field.name)}`
      const normalized = {
        ...field,
        id: Number(field.id),
        parent_field_id: field.parent_field_id == null ? null : Number(field.parent_field_id),
        path: fieldPath,
      }
      fieldsById.set(normalized.id, normalized)
      byPath.set(fieldPath, {
        fieldId: normalized.id,
        structural: indexesByName.has(`idx_values_${normalized.id}_object_parent`),
        query: indexesByName.has(`idx_values_${normalized.id}_query_object`),
        type: indexesByName.has(`idx_values_${normalized.id}_type_object`),
      })
    }

    return {
      policy: JSON.parse(setting.value),
      serializedPolicy: setting.value,
      schemaVersion: Number(version.user_version),
      byPath,
    }
  } finally {
    await closeSqlite(database)
  }
}

/** @param {Map<string, { structural: boolean, query: boolean, type: boolean }>} byPath @param {(path: string) => boolean} expected */
function assertOptionalIndexes(byPath, expected) {
  assert.ok(byPath.size > 0)
  for (const [fieldPath, indexes] of byPath) {
    assert.equal(indexes.structural, true, `missing structural index for ${fieldPath || '<root>'}`)
    assert.equal(indexes.query, expected(fieldPath), `unexpected query index for ${fieldPath || '<root>'}`)
    assert.equal(indexes.type, expected(fieldPath), `unexpected type index for ${fieldPath || '<root>'}`)
  }
}

/** @param {string} filename */
async function sha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex')
}

/** @param {string} destinationPath */
async function readManifest(destinationPath) {
  return JSON.parse(await readFile(path.join(destinationPath, backupManifestFilename), 'utf8'))
}

test('fieldIndexes defaults to auto and preserves explicit all and none modes', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-index-modes-')

  for (const [name, fieldIndexes, expected] of [
    ['default', undefined, false],
    ['auto', 'auto', false],
    ['all', 'all', true],
    ['none', 'none', false],
  ]) {
    const storagePath = path.join(root, name)
    const options = fieldIndexes === undefined
      ? { storagePath }
      : { storagePath, fieldIndexes }
    const database = createIdb(options)
    await database.execute('INSERT INTO documents', {
      key: name,
      profile: { displayName: 'Ada', address: { city: 'Tehran' } },
    })
    await database.close()

    const schema = await inspectFieldIndexes(storagePath, 'documents')
    assert.equal(schema.schemaVersion, 5)
    if (fieldIndexes === undefined || fieldIndexes === 'auto') {
      assert.equal(schema.policy.version, 2)
      assert.equal(schema.policy.mode, 'auto')
    } else {
      assert.deepEqual(schema.policy, { version: 1, default: expected ? 'all' : 'none', rules: [] })
    }
    assertOptionalIndexes(schema.byPath, () => expected)
  }
})

test('selective fieldIndexes apply exact and dot-segment pattern rules', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-index-selective-')
  const storagePath = path.join(root, 'data')
  const database = createIdb({
    storagePath,
    fieldIndexes: {
      default: 'none',
      rules: [
        { collection: '*', path: 'tenantId', enabled: true },
        { collection: 'users', path: 'email', enabled: true },
        { collection: 'users', pattern: 'profile.*', enabled: true },
        { collection: 'users', pattern: 'audit.**', enabled: true },
        { collection: 'users', pattern: 'audit.private.**', enabled: false },
      ],
    },
  })
  await database.execute('INSERT INTO users', {
    tenantId: 'tenant-1',
    email: 'ada@example.test',
    profile: { name: 'Ada', address: { city: 'Tehran' } },
    audit: { actor: { id: 7 }, private: { token: 'secret' } },
    unindexed: 'value',
  })
  await database.close()

  const { byPath } = await inspectFieldIndexes(storagePath, 'users')
  const indexedPaths = new Set([
    'tenantId',
    'email',
    'profile.name',
    'profile.address',
    'audit',
    'audit.actor',
    'audit.actor.id',
  ])
  assertOptionalIndexes(byPath, (fieldPath) => indexedPaths.has(fieldPath))
  assert.equal(byPath.get('profile.address.city')?.query, false)
  assert.equal(byPath.get('audit.private')?.query, false)
  assert.equal(byPath.get('audit.private.token')?.query, false)
  assert.equal(byPath.get('unindexed')?.query, false)
})

test('reopening with a new fieldIndexes policy drops and recreates only optional indexes without changing data', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-index-reconcile-')
  const storagePath = path.join(root, 'data')
  const document = {
    key: 'stable',
    count: 7,
    profile: { city: 'Tehran' },
    payload: Buffer.from([0, 1, 2, 255]),
  }

  const initial = createIdb({ storagePath, fieldIndexes: 'all' })
  await initial.execute('INSERT INTO records', document)
  await initial.close()
  assertOptionalIndexes((await inspectFieldIndexes(storagePath, 'records')).byPath, () => true)

  const withoutOptional = createIdb({ storagePath, fieldIndexes: 'none' })
  assert.deepEqual(await withoutOptional.execute('FIND records'), [document])
  await withoutOptional.close()
  const disabled = await inspectFieldIndexes(storagePath, 'records')
  assertOptionalIndexes(disabled.byPath, () => false)
  assert.equal(disabled.schemaVersion, 5)

  const restored = createIdb({ storagePath, fieldIndexes: 'all' })
  assert.deepEqual(await restored.execute('FIND records'), [document])
  await restored.close()
  const enabled = await inspectFieldIndexes(storagePath, 'records')
  assertOptionalIndexes(enabled.byPath, () => true)
  assert.deepEqual(enabled.policy, { version: 1, default: 'all', rules: [] })
})

test('persisted schema-v5 policy controls new fields across concurrent engines', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-index-shared-policy-')
  const storagePath = path.join(root, 'data')
  const first = createIdb({ storagePath, fieldIndexes: 'none' })
  const second = createIdb({ storagePath, fieldIndexes: 'all' })

  try {
    await first.execute('INSERT INTO shared', { key: 'initial', initiallyUnindexed: true })

    // Opening the collection through the second engine atomically persists and
    // reconciles its policy. The already-open first engine must refresh that
    // persisted policy before creating new fields.
    assert.equal((await second.execute('FIND shared')).length, 1)
    await Promise.all([
      first.execute('INSERT INTO shared', { key: 'first', lateFromFirst: 1 }),
      second.execute('INSERT INTO shared', { key: 'second', lateFromSecond: 2 }),
    ])
  } finally {
    await Promise.all([first.close(), second.close()])
  }

  const schema = await inspectFieldIndexes(storagePath, 'shared')
  assert.equal(schema.schemaVersion, 5)
  assert.deepEqual(schema.policy, { version: 1, default: 'all', rules: [] })
  assertOptionalIndexes(schema.byPath, () => true)

  const reopened = createIdb({ storagePath, mode: 'readonly' })
  try {
    assert.deepEqual(
      (await reopened.execute('FIND shared ORDER BY key')).map(({ key }) => key),
      ['first', 'initial', 'second'],
    )
  } finally {
    await reopened.close()
  }
})

test('automatic indexing learns canonical aliased filters and persists its decision', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-auto-index-learn-')
  const storagePath = path.join(root, 'data')
  const automatic = {
    mode: 'auto',
    preset: 'aggressive',
    minDocuments: 0,
    minQueryCount: 1,
    evaluationInterval: 1,
    cooldownMs: 0,
    maxResultRatio: 1,
    allowDrop: false,
  }
  const database = createIdb({ storagePath, fieldIndexes: automatic })
  await database.execute('INSERT INTO users', [
    { email: 'ada@example.test', name: 'Ada' },
    { email: 'grace@example.test', name: 'Grace' },
  ])
  assert.deepEqual(
    await database.execute('SELECT u.email FROM users u WHERE u.email = ?', ['ada@example.test']),
    [{ object_id: 1, email: 'ada@example.test' }],
  )
  const learned = await waitForManagedIndex(database, 'users', 'email')
  assert.equal(learned.openCollections[0].autoIndexing.managedIndexes[0].path, 'email')
  const [optimization] = await database.optimizeIndexes({ dryRun: true })
  assert.equal(optimization.changed, null)
  assertOptionalIndexes(
    (await inspectFieldIndexes(storagePath, 'users')).byPath,
    (fieldPath) => fieldPath === 'email',
  )
  await database.close()

  const reopened = createIdb({ storagePath })
  try {
    const diagnostics = await reopened.diagnostics()
    assert.equal(diagnostics.openCollections.length, 0)
    await reopened.execute('FIND users WHERE email = ?', ['grace@example.test'])
    const active = await reopened.diagnostics()
    assert.equal(active.openCollections[0].fieldIndexes.mode, 'auto')
    assert.equal(active.openCollections[0].autoIndexing.managedIndexes[0].path, 'email')
  } finally {
    await reopened.close()
  }
})

test('automatic rules are hard pins and an omitted option preserves an existing manual policy', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-auto-index-rules-')
  const automaticPath = path.join(root, 'automatic')
  const automatic = createIdb({
    storagePath: automaticPath,
    fieldIndexes: {
      mode: 'auto',
      preset: 'aggressive',
      minDocuments: 0,
      minQueryCount: 1,
      evaluationInterval: 1,
      cooldownMs: 0,
      maxResultRatio: 1,
      rules: [
        { collection: 'users', path: 'id', enabled: true },
        { collection: 'users', path: 'email', enabled: false },
      ],
    },
  })
  await automatic.execute('INSERT INTO users', { id: 1, email: 'blocked@example.test' })
  await automatic.execute('FIND users WHERE email = ?', ['blocked@example.test'])
  const [plan] = await automatic.optimizeIndexes({ dryRun: true })
  assert.equal(plan.candidates.find(({ path: fieldPath }) => fieldPath === 'email')?.state, 'pinned-disabled')
  assertOptionalIndexes(
    (await inspectFieldIndexes(automaticPath, 'users')).byPath,
    (fieldPath) => fieldPath === 'id',
  )
  await automatic.close()

  const manualPath = path.join(root, 'manual')
  const manual = createIdb({ storagePath: manualPath, fieldIndexes: 'all' })
  await manual.execute('INSERT INTO users', { email: 'stable@example.test' })
  await manual.close()
  const reopened = createIdb({ storagePath: manualPath })
  await reopened.execute('FIND users')
  await reopened.close()
  const preserved = await inspectFieldIndexes(manualPath, 'users')
  assert.deepEqual(preserved.policy, { version: 1, default: 'all', rules: [] })
  assertOptionalIndexes(preserved.byPath, () => true)
})

test('automatic indexing ignores expressions that cannot use predicate indexes', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-auto-index-shapes-')
  const storagePath = path.join(root, 'data')
  const database = createIdb({
    storagePath,
    fieldIndexes: {
      mode: 'auto',
      preset: 'aggressive',
      minDocuments: 0,
      minQueryCount: 1,
      evaluationInterval: 1,
      cooldownMs: 0,
      maxResultRatio: 1,
    },
  })
  try {
    await database.execute('INSERT INTO users', [
      { email: 'Ada@Example.Test' },
      { email: 'Grace@Example.Test' },
    ])
    assert.equal(
      (await database.execute('SELECT email FROM users WHERE LOWER(email) = ?', ['ada@example.test'])).length,
      1,
    )
    const [plan] = await database.optimizeIndexes({ dryRun: true })
    assert.equal(plan.candidates.some(({ path: fieldPath }) => fieldPath === 'email'), false)
    assertOptionalIndexes((await inspectFieldIndexes(storagePath, 'users')).byPath, () => false)
  } finally {
    await database.close()
  }
})

test('automatic removal affects only auto-managed indexes and coordinates concurrent engines', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-auto-index-drop-')
  const storagePath = path.join(root, 'data')
  const policy = {
    mode: 'auto',
    preset: 'aggressive',
    minDocuments: 0,
    minQueryCount: 1,
    evaluationInterval: 100,
    cooldownMs: 0,
    maxResultRatio: 1,
    maxIndexesPerCollection: 1,
    allowDrop: false,
  }
  const first = createIdb({ storagePath, fieldIndexes: policy })
  const second = createIdb({ storagePath, fieldIndexes: policy })
  try {
    await first.execute('INSERT INTO users', [
      { email: 'a@example.test', name: 'A' },
      { email: 'b@example.test', name: 'B' },
    ])
    await first.execute('FIND users WHERE email = ?', ['a@example.test'])
    const concurrent = await Promise.all([
      first.optimizeIndexes(),
      second.optimizeIndexes(),
    ])
    assert.equal(
      concurrent.flat().filter(({ changed }) => changed?.type === 'create').length,
      1,
    )

  } finally {
    await Promise.all([first.close(), second.close()])
  }

  const remover = createIdb({
    storagePath,
    fieldIndexes: {
      ...policy,
      allowDrop: true,
      dropUnusedAfterMs: 0,
      minIndexAgeMs: 0,
    },
  })
  try {
    await remover.execute('FIND users WHERE name = ?', ['B'])
    const [removal] = await remover.optimizeIndexes()
    assert.equal(removal.changed?.type, 'drop')
    assert.equal(removal.changed?.path, 'email')
  } finally {
    await remover.close()
  }
  assertOptionalIndexes((await inspectFieldIndexes(storagePath, 'users')).byPath, () => false)
})

test('backup captures multiple collections, including evicted collections, with verifiable manifest hashes and all value types', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-complete-')
  const storagePath = path.join(root, 'source')
  const destinationPath = path.join(root, 'backup')
  const timestamp = new Date('2026-07-19T12:34:56.789Z')
  const typedDocument = {
    key: 'typed',
    nullValue: null,
    trueValue: true,
    falseValue: false,
    integer: 42,
    decimal: 1.25,
    bigInteger: 9_007_199_254_740_993n,
    timestamp,
    bytes: Buffer.from([0, 1, 127, 128, 255]),
    longText: 'long-value-'.repeat(40),
    values: [1, null, 4n, new Date(10), Buffer.from([9, 8]), { enabled: true }],
    nested: { label: 'nested', nullable: null },
  }
  const database = createIdb({ storagePath, maxOpenCollections: 1 })

  try {
    await database.execute('INSERT INTO alpha', typedDocument)
    // maxOpenCollections=1 evicts alpha; backup must rediscover and reopen it.
    await database.execute('INSERT INTO beta', { key: 'second', active: true })
    const result = await database.backup({ destinationPath, integrityCheck: 'full' })
    assert.equal(result.destinationPath, path.resolve(destinationPath))
    assert.deepEqual(result.collections, ['alpha', 'beta'])
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.collections), true)
    assert.equal(Object.isFrozen(result.files), true)
  } finally {
    await database.close()
  }

  const manifest = await readManifest(destinationPath)
  assert.equal(manifest.format, 'node-idb-backup')
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.consistency, 'per-collection')
  assert.deepEqual(manifest.collections, ['alpha', 'beta'])
  assert.equal(Number.isNaN(Date.parse(manifest.createdAt)), false)
  assert.equal(manifest.files.length, 4)
  assert.deepEqual((await readdir(destinationPath)).sort(), [
    backupManifestFilename,
    'db-blobs-alpha.sqlite',
    'db-blobs-beta.sqlite',
    'db-collection-alpha.sqlite',
    'db-collection-beta.sqlite',
  ])
  for (const file of manifest.files) {
    const filename = path.join(destinationPath, file.filename)
    const bytes = await readFile(filename)
    assert.equal(file.bytes, bytes.byteLength)
    assert.equal(file.sha256, await sha256(filename))
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
  }

  const restored = createIdb({ storagePath: destinationPath, mode: 'readonly' })
  try {
    assert.deepEqual(await restored.execute("FIND alpha WHERE key='typed'"), [typedDocument])
    assert.deepEqual(await restored.execute('FIND beta'), [{ key: 'second', active: true }])
  } finally {
    await restored.close()
  }
})

test('readonly engines can create selected-collection backups without mutating their source', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-readonly-')
  const storagePath = path.join(root, 'source')
  const destinationPath = path.join(root, 'selected')
  const writer = createIdb({ storagePath })
  await writer.execute('INSERT INTO alpha', { key: 'excluded' })
  await writer.execute('INSERT INTO beta', { key: 'included', bytes: Buffer.from('beta') })
  await writer.close()

  const before = new Map()
  for (const filename of await readdir(storagePath)) {
    before.set(filename, await sha256(path.join(storagePath, filename)))
  }

  const reader = createIdb({ storagePath, mode: 'readonly' })
  try {
    assert.deepEqual(await reader.execute('FIND beta'), [
      { key: 'included', bytes: Buffer.from('beta') },
    ])
    const result = await reader.backup({
      destinationPath,
      collections: ['BeTa'],
    })
    assert.deepEqual(result.collections, ['beta'])
  } finally {
    await reader.close()
  }

  const manifest = await readManifest(destinationPath)
  assert.deepEqual(manifest.collections, ['beta'])
  assert.deepEqual((await readdir(destinationPath)).sort(), [
    backupManifestFilename,
    'db-blobs-beta.sqlite',
    'db-collection-beta.sqlite',
  ])
  for (const [filename, digest] of before) {
    assert.equal(await sha256(path.join(storagePath, filename)), digest)
  }

  const restored = createIdb({ storagePath: destinationPath, mode: 'readonly' })
  try {
    assert.deepEqual(await restored.execute('FIND beta'), [
      { key: 'included', bytes: Buffer.from('beta') },
    ])
    await assert.rejects(restored.execute('FIND alpha'), /does not exist.*read-only/i)
  } finally {
    await restored.close()
  }
})

test('backup overwrite safeguards reject arbitrary and existing destinations and replace only recognized backups', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-overwrite-')
  const storagePath = path.join(root, 'source')
  const destinationPath = path.join(root, 'backup')
  const arbitraryPath = path.join(root, 'arbitrary')
  const database = createIdb({ storagePath })

  try {
    await database.execute('INSERT INTO revisions', { revision: 1 })
    await database.backup({ destinationPath })
    const originalManifest = await readFile(path.join(destinationPath, backupManifestFilename), 'utf8')

    await database.execute('INSERT INTO revisions', { revision: 2 })
    await assert.rejects(
      database.backup({ destinationPath }),
      /destination already exists/i,
    )
    assert.equal(
      await readFile(path.join(destinationPath, backupManifestFilename), 'utf8'),
      originalManifest,
    )

    await mkdir(arbitraryPath)
    await writeFile(path.join(arbitraryPath, 'keep.txt'), 'do not replace')
    await assert.rejects(
      database.backup({ destinationPath: arbitraryPath, overwrite: true }),
      /recognized node-idb backup|manifest/i,
    )
    assert.equal(await readFile(path.join(arbitraryPath, 'keep.txt'), 'utf8'), 'do not replace')

    await database.backup({ destinationPath, overwrite: true })
  } finally {
    await database.close()
  }

  const restored = createIdb({ storagePath: destinationPath, mode: 'readonly' })
  try {
    assert.deepEqual(await restored.execute('FIND revisions ORDER BY revision'), [
      { revision: 1 },
      { revision: 2 },
    ])
  } finally {
    await restored.close()
  }
})

test('backup rejects destinations overlapping the source in either direction', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-overlap-')
  const storagePath = path.join(root, 'source')
  const database = createIdb({ storagePath })

  try {
    await database.execute('INSERT INTO records', { key: 'source' })
    await assert.rejects(
      database.backup({ destinationPath: path.join(storagePath, 'nested-backup') }),
      /paths must not overlap/i,
    )
    await assert.rejects(
      database.backup({ destinationPath: root }),
      /paths must not overlap/i,
    )
  } finally {
    await database.close()
  }

  await assert.rejects(access(path.join(storagePath, 'nested-backup')))
  assert.deepEqual(await readdir(root), ['source'])
})

test('backup honors an already-aborted signal before staging any destination', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-aborted-')
  const storagePath = path.join(root, 'source')
  const destinationPath = path.join(root, 'backup')
  const database = createIdb({ storagePath })
  const controller = new AbortController()
  controller.abort(new Error('cancel this backup'))

  try {
    await assert.rejects(
      database.backup({
        destinationPath,
        signal: { aborted: false, addEventListener() {} },
      }),
      /signal must be an AbortSignal/i,
    )
    await assert.rejects(
      database.backup({ destinationPath, signal: controller.signal }),
      (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
    )
    await assert.rejects(access(destinationPath))
    assert.deepEqual(await readdir(root), [])
  } finally {
    await database.close()
  }
})

test('backup is ordered after prior operations, gates later operations, and is awaited by close', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-scheduling-')
  const storagePath = path.join(root, 'source')
  const destinationPath = path.join(root, 'backup')
  const database = createIdb({ storagePath })
  const initialDocuments = Array.from({ length: 200 }, (_, index) => ({
    phase: 'before',
    index,
    payload: `value-${index}`.repeat(5),
  }))

  const priorWrite = database.execute('INSERT INTO scheduling', initialDocuments)
  const backup = database.backup({ destinationPath })
  const laterWrite = database.execute('INSERT INTO scheduling', { phase: 'after', index: 999 })
  const closing = database.close()

  const [ids, backupResult, laterId] = await Promise.all([
    priorWrite,
    backup,
    laterWrite,
    closing,
  ])
  assert.equal(ids.length, initialDocuments.length)
  assert.deepEqual(backupResult.collections, ['scheduling'])
  assert.equal(typeof laterId, 'number')
  await assert.rejects(database.execute('FIND scheduling'), /closed/i)

  const source = createIdb({ storagePath, mode: 'readonly' })
  const snapshot = createIdb({ storagePath: destinationPath, mode: 'readonly' })
  try {
    assert.equal((await source.execute('FIND scheduling')).length, initialDocuments.length + 1)
    assert.equal((await snapshot.execute('FIND scheduling')).length, initialDocuments.length)
    assert.deepEqual(await snapshot.execute("FIND scheduling WHERE phase='after'"), [])
  } finally {
    await Promise.all([source.close(), snapshot.close()])
  }
})

test('backups remain internally consistent while another engine writes large values', async (context) => {
  const root = await temporaryRoot(context, 'node-idb-backup-concurrent-writer-')
  const storagePath = path.join(root, 'source')
  const destinations = Array.from(
    { length: 3 },
    (_, index) => path.join(root, `backup-${index}`),
  )
  const writer = createIdb({ storagePath, busyTimeoutMs: 30_000, fieldIndexes: 'none' })
  const backupper = createIdb({ storagePath, busyTimeoutMs: 30_000, fieldIndexes: 'none' })
  const payload = (version) => Buffer.alloc(128 * 1_024, version & 0xff)

  await writer.execute('INSERT INTO consistency', {
    key: 'current',
    version: 0,
    payload: payload(0),
  })

  let completedWrites = 0
  const writes = (async () => {
    for (let version = 1; version <= 20; version++) {
      await writer.execute("REPLACE INTO consistency WHERE key='current'", {
        key: 'current',
        version,
        payload: payload(version),
      })
      completedWrites = version
      await delay(5)
    }
  })()

  try {
    for (const destinationPath of destinations) {
      await backupper.backup({ destinationPath })
      await delay(10)
    }
    await writes
    assert.ok(completedWrites > 0)
  } finally {
    await Promise.allSettled([writes])
    await Promise.all([writer.close(), backupper.close()])
  }

  for (const destinationPath of destinations) {
    const snapshot = createIdb({ storagePath: destinationPath, mode: 'readonly' })
    try {
      const [document] = await snapshot.execute("FIND consistency WHERE key='current'")
      assert.ok(document)
      assert.ok(Number.isSafeInteger(document.version))
      assert.deepEqual(document.payload, payload(document.version))
    } finally {
      await snapshot.close()
    }
  }
})
