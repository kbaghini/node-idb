import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { createIdb, inspectStorage } from 'node-idb'

import {
  generateCompanies,
  generateContacts,
  generateGroupMemberships,
  generateGroups,
  generateInteractions,
  validatePhonebookConfig,
} from './data.js'

const SEED_KEY = 'node-idb-phonebook-studio'
const SEED_VERSION = 2
const lockFilename = '.node-idb-phonebook-seed.lock'
const inProgressFilename = '.node-idb-phonebook-seed.in-progress.json'
const readyFilename = '.node-idb-phonebook-seed.ready.json'
const activeSeedPaths = new Set()

const dataCollections = Object.freeze([
  'companies',
  'groups',
  'contacts',
  'group_memberships',
  'interactions',
])

const cleanupOrder = Object.freeze([
  'phonebook_meta',
  'interactions',
  'group_memberships',
  'contacts',
  'groups',
  'companies',
])

export const PHONEBOOK_INDEX_POLICY = Object.freeze({
  mode: 'auto',
  preset: 'balanced',
  maxIndexesPerCollection: 24,
  rules: Object.freeze([
    Object.freeze({ collection: 'phonebook_meta', path: 'key', enabled: true }),
    Object.freeze({ collection: 'companies', path: 'companyCode', enabled: true }),
    Object.freeze({ collection: 'groups', path: 'groupCode', enabled: true }),
    Object.freeze({ collection: 'contacts', path: 'contactCode', enabled: true }),
    Object.freeze({ collection: 'contacts', path: 'email', enabled: true }),
    Object.freeze({ collection: 'contacts', path: 'companyRef.objectId', enabled: true }),
    Object.freeze({ collection: 'group_memberships', path: 'contactRef.objectId', enabled: true }),
    Object.freeze({ collection: 'group_memberships', path: 'groupRef.objectId', enabled: true }),
    Object.freeze({ collection: 'interactions', path: 'contactRef.objectId', enabled: true }),
    Object.freeze({ collection: 'interactions', path: 'companyRef.objectId', enabled: true }),
  ]),
})

/** @param {unknown} value */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === 'object' && error.code === code)
}

/** @param {string} filename @param {string} label */
async function readStateFile(filename, label) {
  let source
  try {
    source = await readFile(filename, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    const value = JSON.parse(source)
    if (!isPlainObject(value)) throw new Error('expected a JSON object')
    return /** @type {Record<string, any>} */ (value)
  } catch (error) {
    throw new Error(
      `${label} is invalid; inspect the sample directory before removing or repairing it: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** @param {string} filename @param {Record<string, unknown>} value */
async function writeStateFile(filename, value) {
  let handle
  try {
    handle = await open(filename, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(filename, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
}

/** @param {Record<string, any>} value @param {string} label */
function validateStateOwnership(value, label) {
  if (
    value.key !== SEED_KEY ||
    !Number.isSafeInteger(value.seedVersion) ||
    value.seedVersion < 1 ||
    typeof value.signature !== 'string' ||
    !value.signature
  ) {
    throw new Error(
      `${label} does not identify this Phonebook sample version; inspect the directory manually`,
    )
  }
  return value
}

/** @param {unknown} value @param {Record<string, number>} expected */
function sameConfig(value, expected) {
  if (!isPlainObject(value)) return false
  const candidate = /** @type {Record<string, any>} */ (value)
  const keys = Object.keys(expected)
  return Object.keys(candidate).length === keys.length &&
    keys.every((key) => candidate[key] === expected[key])
}

/**
 * @param {unknown} value
 * @param {string} signature
 * @param {Record<string, number>} config
 * @param {Record<string, number>} counts
 */
function validDatabaseManifest(value, signature, config, counts) {
  if (!isPlainObject(value)) return false
  const manifest = /** @type {Record<string, any>} */ (value)
  const keys = [
    'key',
    'seedVersion',
    'signature',
    'config',
    'counts',
    'seededAt',
    'relationshipModel',
  ]
  return Object.keys(manifest).length === keys.length &&
    keys.every((key) => Object.hasOwn(manifest, key)) &&
    manifest.key === SEED_KEY &&
    manifest.seedVersion === SEED_VERSION &&
    manifest.signature === signature &&
    sameConfig(manifest.config, config) &&
    sameCounts(manifest.counts, counts) &&
    manifest.seededAt instanceof Date &&
    !Number.isNaN(manifest.seededAt.getTime()) &&
    manifest.relationshipModel === 'nested application-level objectId references'
}

const countKeys = Object.freeze([
  'companies',
  'groups',
  'contacts',
  'groupMemberships',
  'interactions',
  'total',
])

/** @param {unknown} value @param {string} label */
function validatedCounts(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} counts are missing or invalid`)
  const counts = /** @type {Record<string, any>} */ (value)
  if (
    Object.keys(counts).length !== countKeys.length ||
    countKeys.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 1)
  ) {
    throw new Error(`${label} counts are missing or invalid`)
  }
  const calculated = counts.companies + counts.groups + counts.contacts +
    counts.groupMemberships + counts.interactions
  if (counts.total !== calculated) throw new Error(`${label} total count is inconsistent`)
  return Object.freeze(Object.fromEntries(countKeys.map((key) => [key, counts[key]])))
}

/** @param {unknown} left @param {unknown} right */
function sameCounts(left, right) {
  try {
    const first = validatedCounts(left, 'first state')
    const second = validatedCounts(right, 'second state')
    return countKeys.every((key) => first[key] === second[key])
  } catch {
    return false
  }
}

/** @param {string} storagePath */
async function acquireSeedLock(storagePath) {
  if (activeSeedPaths.has(storagePath)) {
    throw new Error(`Phonebook storage is already being seeded in this process: ${storagePath}`)
  }
  activeSeedPaths.add(storagePath)
  const lockPath = path.join(storagePath, lockFilename)
  const token = randomUUID()
  let handle
  try {
    await mkdir(storagePath, { recursive: true })
    handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({
      key: SEED_KEY,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle?.close().catch(() => {})
    activeSeedPaths.delete(storagePath)
    if (hasCode(error, 'EEXIST')) {
      const owner = await readStateFile(lockPath, 'Phonebook seed lock').catch(() => null)
      throw new Error(
        `Another Phonebook seeder may be using ${storagePath}` +
        `${owner?.pid ? ` (process ${owner.pid})` : ''}. ` +
        `If that process no longer exists, inspect and remove ${lockPath} before retrying.`,
      )
    }
    await rm(lockPath, { force: true }).catch(() => {})
    throw error
  }

  let released = false
  return async function releaseSeedLock() {
    if (released) return
    released = true
    await handle.close().catch(() => {})
    try {
      const current = await readStateFile(lockPath, 'Phonebook seed lock')
      if (current?.token === token) await rm(lockPath, { force: true })
    } finally {
      activeSeedPaths.delete(storagePath)
    }
  }
}

/** @param {string} storagePath */
function statePaths(storagePath) {
  return Object.freeze({
    inProgress: path.join(storagePath, inProgressFilename),
    ready: path.join(storagePath, readyFilename),
  })
}

/** @param {{inProgress: string, ready: string}} files @param {string} signature */
async function beginSeedState(files, signature) {
  await rm(files.inProgress, { force: true })
  await writeStateFile(files.inProgress, {
    key: SEED_KEY,
    seedVersion: SEED_VERSION,
    signature,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })
  // No collection mutation begins while a previous ready marker still exists.
  await rm(files.ready, { force: true })
}

/**
 * @param {{inProgress: string, ready: string}} files
 * @param {string} signature
 * @param {Record<string, number>} counts
 */
async function finishSeedState(files, signature, counts) {
  await writeStateFile(files.ready, {
    key: SEED_KEY,
    seedVersion: SEED_VERSION,
    signature,
    counts,
    completedAt: new Date().toISOString(),
  })
  await rm(files.inProgress, { force: true })
}

/** @param {Record<string, number>} config */
function seedSignature(config) {
  return `${SEED_VERSION}:${JSON.stringify(config)}`
}

/**
 * @param {ReturnType<typeof createIdb>} database
 * @param {string} collection
 * @param {readonly unknown[]} documents
 * @param {number} batchSize
 * @param {(message: string) => void} progress
 */
async function insertDocuments(database, collection, documents, batchSize, progress) {
  const objectIds = []
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const chunk = documents.slice(offset, offset + batchSize)
    const inserted = await database.execute(`INSERT INTO ${collection}`, chunk)
    if (
      !Array.isArray(inserted) ||
      inserted.length !== chunk.length ||
      inserted.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
      throw new Error(`Unexpected object IDs returned while seeding ${collection}`)
    }
    objectIds.push(...inserted)
    progress(`  ${collection}: ${Math.min(offset + chunk.length, documents.length)}/${documents.length}`)
  }
  return objectIds
}

/** @param {unknown} rawOptions */
export async function seedPhonebook(rawOptions) {
  if (!isPlainObject(rawOptions)) throw new TypeError('seedPhonebook requires an options object')
  const options = /** @type {Record<string, any>} */ (rawOptions)
  const allowed = ['storagePath', 'config', 'reseed', 'batchSize', 'onProgress']
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`Unknown seedPhonebook option: ${unknown.join(', ')}`)
  if (typeof options.storagePath !== 'string' || !options.storagePath.trim()) {
    throw new TypeError('seedPhonebook storagePath must be a non-empty string')
  }
  if (options.storagePath === ':memory:') {
    throw new TypeError('The Phonebook Studio sample requires a filesystem storagePath')
  }
  if (options.reseed !== undefined && typeof options.reseed !== 'boolean') {
    throw new TypeError('seedPhonebook reseed must be a boolean')
  }
  const batchSize = options.batchSize ?? 250
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new RangeError('seedPhonebook batchSize must be an integer from 1 through 2000')
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new TypeError('seedPhonebook onProgress must be a function')
  }

  const config = validatePhonebookConfig(options.config)
  const signature = seedSignature(config)
  const storagePath = path.resolve(options.storagePath)
  const progress = options.onProgress ?? (() => {})
  const started = performance.now()
  const releaseSeedLock = await acquireSeedLock(storagePath)
  const files = statePaths(storagePath)
  let database

  try {
    const [readyState, inProgressState, inspection] = await Promise.all([
      readStateFile(files.ready, 'Phonebook ready state'),
      readStateFile(files.inProgress, 'Phonebook in-progress state'),
      inspectStorage({ storagePath, integrityCheck: 'none' }),
    ])
    const ready = readyState
      ? validateStateOwnership(readyState, 'Phonebook ready state')
      : null
    if (inProgressState) {
      validateStateOwnership(inProgressState, 'Phonebook in-progress state')
    }
    for (const [label, state] of [
      ['ready', ready],
      ['in-progress', inProgressState],
    ]) {
      if (!state) continue
      if (state.seedVersion > SEED_VERSION) {
        throw new Error(
          `The Phonebook ${label} state was created by a newer sample version; ` +
          'use that version to inspect or rebuild it.',
        )
      }
      if (state.seedVersion < SEED_VERSION && options.reseed !== true) {
        throw new Error(
          `The Phonebook ${label} state uses an older seed schema. ` +
          'No data was changed; run with --reseed to rebuild it.',
        )
      }
    }
    const existingCollections = new Set(
      inspection.collections.map(({ collection }) => collection.toLowerCase()),
    )

    if (ready && options.reseed !== true) {
      if (ready.signature !== signature) {
        throw new Error(
          'The Phonebook sample was created with different counts, seed, or schema. ' +
          'Run with --reseed to replace its known sample collections.',
        )
      }
      const missingCollections = cleanupOrder.filter(
        (collection) => !existingCollections.has(collection),
      )
      if (missingCollections.length) {
        throw new Error(
          `Phonebook storage is incomplete (${missingCollections.join(', ')} missing). ` +
          'No data was changed; run with --reseed to rebuild it.',
        )
      }
      const readyCounts = validatedCounts(ready.counts, 'Phonebook ready state')
      database = createIdb({
        storagePath,
        mode: 'readonly',
        maxOpenCollections: 8,
      })
      const manifests = await database.execute(
        'SELECT * FROM phonebook_meta WHERE key = ? ORDER BY object_id',
        [SEED_KEY],
      )
      if (
        !Array.isArray(manifests) ||
        manifests.length !== 1 ||
        !validDatabaseManifest(manifests[0], signature, config, readyCounts)
      ) {
        throw new Error(
          'Phonebook database metadata is missing or was edited. No data was changed; ' +
          'run with --reseed to rebuild the known sample collections.',
        )
      }
      // A ready file is removed before any reseed mutation, so both files can
      // coexist only when a previous attempt stopped before changing data.
      if (inProgressState) await rm(files.inProgress, { force: true })
      progress('Phonebook data already exists; preserving any edits made in Studio.')
      return Object.freeze({
        seeded: false,
        storagePath,
        config,
        counts: readyCounts,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
      })
    }

    if (!ready && !inProgressState && existingCollections.size && options.reseed !== true) {
      throw new Error(
        'The target contains node-idb collections but has no Phonebook ownership state. ' +
        'No data was changed; use a dedicated empty path or explicitly pass --reseed.',
      )
    }

    await beginSeedState(files, signature)
    database = createIdb({
      storagePath,
      maxOpenCollections: 8,
      fieldIndexes: PHONEBOOK_INDEX_POLICY,
    })
    progress(ready || inProgressState || existingCollections.size
      ? 'Rebuilding the Phonebook sample...'
      : 'Preparing the Phonebook sample...')
    // The external ready state has already been removed. If this process is
    // interrupted, the surviving in-progress state authorizes safe recovery.
    for (const collection of cleanupOrder) {
      await database.execute(`DELETE FROM ${collection}`)
    }

    progress('Generating and inserting companies...')
    const companies = generateCompanies(config)
    const companyIds = await insertDocuments(
      database,
      'companies',
      companies,
      batchSize,
      progress,
    )

    progress('Generating and inserting groups...')
    const groups = generateGroups(config, companyIds)
    const groupIds = await insertDocuments(database, 'groups', groups, batchSize, progress)

    progress('Generating and inserting contacts...')
    const contacts = generateContacts(config, companyIds)
    const contactIds = await insertDocuments(
      database,
      'contacts',
      contacts,
      batchSize,
      progress,
    )

    progress('Generating and inserting group memberships...')
    const memberships = generateGroupMemberships(config, contactIds, groupIds)
    await insertDocuments(
      database,
      'group_memberships',
      memberships,
      batchSize,
      progress,
    )

    progress('Generating and inserting interactions...')
    const interactions = generateInteractions(config, contacts, contactIds)
    await insertDocuments(
      database,
      'interactions',
      interactions,
      batchSize,
      progress,
    )

    const counts = Object.freeze({
      companies: companies.length,
      groups: groups.length,
      contacts: contacts.length,
      groupMemberships: memberships.length,
      interactions: interactions.length,
      total: companies.length + groups.length + contacts.length + memberships.length + interactions.length,
    })

    progress('Updating SQLite planner statistics...')
    await database.analyze({ collections: dataCollections })

    // This marker is deliberately the final document mutation.
    await database.execute('INSERT INTO phonebook_meta', {
      key: SEED_KEY,
      seedVersion: SEED_VERSION,
      signature,
      config: { ...config },
      counts: { ...counts },
      seededAt: new Date(),
      relationshipModel: 'nested application-level objectId references',
    })
    await finishSeedState(files, signature, counts)

    progress(`Phonebook seed complete: ${counts.total.toLocaleString('en-US')} documents.`)
    return Object.freeze({
      seeded: true,
      storagePath,
      config,
      counts,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
    })
  } finally {
    try {
      await database?.close()
    } finally {
      await releaseSeedLock()
    }
  }
}
