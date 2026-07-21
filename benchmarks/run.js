#!/usr/bin/env node

import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'

import { createIdb } from '../src/index.js'

const BENCHMARK_FORMAT_VERSION = 1
const TEMPORARY_DIRECTORY_PREFIX = 'node-idb-benchmark-'
const OWNERSHIP_MARKER = '.node-idb-benchmark.lock'

const presets = Object.freeze({
  quick: Object.freeze({
    documents: 200,
    insertBatchSize: 50,
    pointQueries: 100,
    rangeQueries: 30,
    rangeWidth: 20,
    updates: 75,
    warmupQueries: 10,
    cacheChurnCollections: 8,
    cacheChurnQueries: 24,
    payloadBytes: 96,
    seed: 0x1db2026,
    busyTimeoutMs: 10_000,
    durability: 'balanced',
    fieldIndexes: 'focused',
    maxOpenCollections: 4,
  }),
  standard: Object.freeze({
    documents: 5_000,
    insertBatchSize: 250,
    pointQueries: 2_000,
    rangeQueries: 500,
    rangeWidth: 100,
    updates: 1_000,
    warmupQueries: 100,
    cacheChurnCollections: 32,
    cacheChurnQueries: 500,
    payloadBytes: 256,
    seed: 0x1db2026,
    busyTimeoutMs: 10_000,
    durability: 'balanced',
    fieldIndexes: 'focused',
    maxOpenCollections: 8,
  }),
  stress: Object.freeze({
    documents: 50_000,
    insertBatchSize: 500,
    pointQueries: 20_000,
    rangeQueries: 5_000,
    rangeWidth: 500,
    updates: 10_000,
    warmupQueries: 500,
    cacheChurnCollections: 128,
    cacheChurnQueries: 5_000,
    payloadBytes: 1_024,
    seed: 0x1db2026,
    busyTimeoutMs: 30_000,
    durability: 'balanced',
    fieldIndexes: 'focused',
    maxOpenCollections: 16,
  }),
})

const valueOptions = new Map([
  ['--preset', 'preset'],
  ['--documents', 'documents'],
  ['--insert-batch-size', 'insertBatchSize'],
  ['--point-queries', 'pointQueries'],
  ['--range-queries', 'rangeQueries'],
  ['--range-width', 'rangeWidth'],
  ['--updates', 'updates'],
  ['--warmup-queries', 'warmupQueries'],
  ['--cache-churn-collections', 'cacheChurnCollections'],
  ['--cache-churn-queries', 'cacheChurnQueries'],
  ['--payload-bytes', 'payloadBytes'],
  ['--seed', 'seed'],
  ['--busy-timeout-ms', 'busyTimeoutMs'],
  ['--durability', 'durability'],
  ['--field-indexes', 'fieldIndexes'],
  ['--max-open-collections', 'maxOpenCollections'],
  ['--storage-path', 'storagePath'],
  ['--format', 'format'],
  ['--output', 'output'],
])

const numericOptions = Object.freeze({
  documents: { minimum: 1, maximum: 10_000_000 },
  insertBatchSize: { minimum: 1, maximum: 100_000 },
  pointQueries: { minimum: 0, maximum: 100_000_000 },
  rangeQueries: { minimum: 0, maximum: 100_000_000 },
  rangeWidth: { minimum: 1, maximum: 10_000_000 },
  updates: { minimum: 0, maximum: 100_000_000 },
  warmupQueries: { minimum: 0, maximum: 1_000_000 },
  cacheChurnCollections: { minimum: 1, maximum: 100_000 },
  cacheChurnQueries: { minimum: 0, maximum: 100_000_000 },
  payloadBytes: { minimum: 0, maximum: 1_000_000 },
  seed: { minimum: 0, maximum: 0xffff_ffff },
  busyTimeoutMs: { minimum: 0, maximum: 2_147_483_647 },
  maxOpenCollections: { minimum: 1, maximum: 1_000_000 },
})

function usage() {
  return `node-idb repeatable benchmark

Usage:
  node benchmarks/run.js [options]

Presets and output:
  --preset quick|standard|stress      Workload preset (default: quick)
  --format human|json                 Standard-output format (default: human)
  --json                              Shorthand for --format json
  --output <file>                     Also write the complete report as JSON

Workload overrides:
  --documents <n>                     Documents inserted
  --insert-batch-size <n>             Documents per INSERT call
  --point-queries <n>                 Indexed key lookups
  --range-queries <n>                 Ordered ordinal range lookups
  --range-width <n>                   Ordinals requested per range lookup
  --updates <n>                       Key-selected document updates
  --warmup-queries <n>                Unmeasured point-query warmups
  --cache-churn-collections <n>       Collections cycled in the churn phase
  --cache-churn-queries <n>           Measured churn lookups
  --payload-bytes <n>                 Approximate repeated-text field size
  --seed <n>                          Unsigned 32-bit deterministic seed

Database options:
  --durability strict|balanced
  --busy-timeout-ms <n>
  --field-indexes auto|all|none|focused
                                      auto learns from the measured workload;
                                      focused indexes benchmark predicates
  --max-open-collections <n>
  --storage-path <path>               Use and retain a new or empty directory
  --keep                              Retain the default temporary directory

Safety:
  Without --storage-path, a dedicated OS temporary directory is created and
  removed after the run. A user-supplied directory is never deleted and must
  be absent or empty, preventing accidental mixing with existing data.
`
}

function parseArguments(argv) {
  const raw = {}
  let help = false
  let keep = false

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--keep') {
      keep = true
      continue
    }
    if (argument === '--json') {
      raw.format = 'json'
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected positional argument: ${argument}`)

    const equalsIndex = argument.indexOf('=')
    const flag = equalsIndex < 0 ? argument : argument.slice(0, equalsIndex)
    const key = valueOptions.get(flag)
    if (!key) throw new Error(`Unknown option: ${flag}`)

    let value = equalsIndex < 0 ? argv[++index] : argument.slice(equalsIndex + 1)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (value === '') throw new Error(`${flag} requires a non-empty value`)
    raw[key] = value
  }

  if (help) return { help: true }
  const preset = raw.preset ?? 'quick'
  if (!Object.hasOwn(presets, preset)) {
    throw new Error(`--preset must be one of: ${Object.keys(presets).join(', ')}`)
  }

  const configuration = { ...presets[preset], preset, keep }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'preset') continue
    if (Object.hasOwn(numericOptions, key)) {
      const number = Number(value)
      const { minimum, maximum } = numericOptions[key]
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new Error(`--${toKebabCase(key)} must be an integer from ${minimum} through ${maximum}`)
      }
      configuration[key] = number
    } else {
      configuration[key] = value
    }
  }

  configuration.format ??= 'human'
  if (!['human', 'json'].includes(configuration.format)) {
    throw new Error('--format must be either human or json')
  }
  if (!['strict', 'balanced'].includes(configuration.durability)) {
    throw new Error('--durability must be either strict or balanced')
  }
  if (!['auto', 'all', 'none', 'focused'].includes(configuration.fieldIndexes)) {
    throw new Error('--field-indexes must be auto, all, none, or focused')
  }

  return { help: false, configuration }
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
}

function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function randomInteger(random, maximumExclusive) {
  return Math.floor(random() * maximumExclusive)
}

function documentKey(ordinal) {
  return `document-${String(ordinal).padStart(10, '0')}`
}

function createDocuments(configuration) {
  const random = createRandom(configuration.seed)
  const payload = 'x'.repeat(configuration.payloadBytes)
  const categories = ['alpha', 'beta', 'gamma', 'delta']
  const regions = ['north', 'south', 'east', 'west']

  return Array.from({ length: configuration.documents }, (_, ordinal) => ({
    key: documentKey(ordinal),
    ordinal,
    score: randomInteger(random, 1_000_000),
    active: ordinal % 3 !== 0,
    category: categories[ordinal % categories.length],
    title: `Deterministic benchmark document ${ordinal}`,
    metadata: {
      region: regions[randomInteger(random, regions.length)],
      rank: randomInteger(random, 10_000),
    },
    tags: [`tag-${ordinal % 11}`, `bucket-${ordinal % 37}`],
    payload,
  }))
}

function createWorkload(configuration) {
  const pointRandom = createRandom(configuration.seed ^ 0x706f696e)
  const rangeRandom = createRandom(configuration.seed ^ 0x72616e67)
  const updateRandom = createRandom(configuration.seed ^ 0x75706461)
  const rangeWidth = Math.min(configuration.rangeWidth, configuration.documents)
  const rangeStartCount = configuration.documents - rangeWidth + 1

  return {
    warmupKeys: Array.from(
      { length: configuration.warmupQueries },
      () => documentKey(randomInteger(pointRandom, configuration.documents)),
    ),
    pointKeys: Array.from(
      { length: configuration.pointQueries },
      () => documentKey(randomInteger(pointRandom, configuration.documents)),
    ),
    rangeStarts: Array.from(
      { length: configuration.rangeQueries },
      () => randomInteger(rangeRandom, rangeStartCount),
    ),
    rangeWidth,
    updateKeys: Array.from(
      { length: configuration.updates },
      () => documentKey(randomInteger(updateRandom, configuration.documents)),
    ),
  }
}

function fieldIndexPolicy(mode) {
  if (mode === 'auto' || mode === 'all' || mode === 'none') return mode
  return {
    default: 'none',
    rules: [
      { collection: '*', path: 'key', enabled: true },
      { collection: 'benchmark_documents', path: 'ordinal', enabled: true },
    ],
  }
}

async function pathInformation(target) {
  try {
    return await stat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function prepareStorage(configuration) {
  if (configuration.storagePath === ':memory:') {
    return {
      storagePath: ':memory:',
      kind: 'memory',
      retained: false,
      async cleanup() {},
    }
  }

  if (configuration.storagePath !== undefined) {
    const storagePath = path.resolve(configuration.storagePath)
    const information = await pathInformation(storagePath)
    if (information && !information.isDirectory()) {
      throw new Error(`--storage-path is not a directory: ${storagePath}`)
    }
    if (information && (await readdir(storagePath)).length > 0) {
      throw new Error(`--storage-path must be absent or empty; existing data was not touched: ${storagePath}`)
    }
    if (!information) await mkdir(storagePath, { recursive: true })

    const markerPath = path.join(storagePath, OWNERSHIP_MARKER)
    let marker
    try {
      marker = await open(markerPath, 'wx')
      await marker.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      const unexpectedEntries = (await readdir(storagePath))
        .filter((entry) => entry !== OWNERSHIP_MARKER)
      if (unexpectedEntries.length) {
        throw new Error(`--storage-path changed while it was being claimed; existing data was not touched: ${storagePath}`)
      }
    } catch (error) {
      if (marker) {
        await marker.close().catch(() => {})
        await unlink(markerPath).catch(() => {})
      } else if (error?.code === 'EEXIST') {
        throw new Error(`--storage-path is already claimed by another benchmark: ${storagePath}`, { cause: error })
      }
      throw error
    }

    return {
      storagePath,
      kind: 'user',
      retained: true,
      async cleanup() {
        await marker.close()
        await unlink(markerPath)
      },
    }
  }

  const temporaryRoot = path.resolve(os.tmpdir())
  const storagePath = await mkdtemp(path.join(temporaryRoot, TEMPORARY_DIRECTORY_PREFIX))
  return {
    storagePath,
    kind: 'temporary',
    retained: configuration.keep,
    async cleanup() {
      if (configuration.keep) return
      const resolved = path.resolve(storagePath)
      const safe = path.dirname(resolved) === temporaryRoot &&
        path.basename(resolved).startsWith(TEMPORARY_DIRECTORY_PREFIX)
      if (!safe) throw new Error(`Refusing to remove an unexpected benchmark path: ${resolved}`)
      await rm(resolved, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    },
  }
}

function percentile(sortedSamples, fraction) {
  if (!sortedSamples.length) return null
  const index = (sortedSamples.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sortedSamples[lower]
  const weight = index - lower
  return sortedSamples[lower] * (1 - weight) + sortedSamples[upper] * weight
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(3))
}

function summarizePhase({ items, itemUnit, samples, sampleUnit, durationMs, setupItems = 0 }) {
  const sorted = [...samples].sort((left, right) => left - right)
  const mean = sorted.length
    ? sorted.reduce((total, sample) => total + sample, 0) / sorted.length
    : null
  return {
    items,
    itemUnit,
    measuredCalls: samples.length,
    sampleUnit,
    setupItems,
    durationMs: rounded(durationMs),
    throughputPerSecond: durationMs > 0 ? rounded(items / (durationMs / 1_000)) : null,
    latencyMs: {
      minimum: rounded(sorted[0] ?? null),
      mean: rounded(mean),
      p50: rounded(percentile(sorted, 0.5)),
      p95: rounded(percentile(sorted, 0.95)),
      p99: rounded(percentile(sorted, 0.99)),
      maximum: rounded(sorted.at(-1) ?? null),
    },
  }
}

async function measuredCall(samples, operation) {
  const started = performance.now()
  const result = await operation()
  samples.push(performance.now() - started)
  return result
}

function chunks(values, size) {
  const result = []
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size))
  }
  return result
}

async function insertPhase(database, documents, configuration) {
  const samples = []
  const batches = chunks(documents, configuration.insertBatchSize)
  const started = performance.now()

  for (const batch of batches) {
    const result = await measuredCall(
      samples,
      () => database.execute('INSERT INTO benchmark_documents', batch),
    )
    const inserted = Array.isArray(result) ? result.length : 1
    if (inserted !== batch.length) {
      throw new Error(`INSERT returned ${inserted} IDs for a batch of ${batch.length}`)
    }
  }

  return summarizePhase({
    items: documents.length,
    itemUnit: 'documents',
    samples,
    sampleUnit: 'batch',
    durationMs: performance.now() - started,
  })
}

async function pointQueryPhase(database, workload) {
  for (const key of workload.warmupKeys) {
    await database.execute('SELECT key FROM benchmark_documents WHERE key = ?', [key])
  }

  const samples = []
  const started = performance.now()
  for (const key of workload.pointKeys) {
    const rows = await measuredCall(
      samples,
      () => database.execute('SELECT key FROM benchmark_documents WHERE key = ?', [key]),
    )
    if (rows.length !== 1 || rows[0].key !== key) {
      throw new Error(`Point-query verification failed for ${key}`)
    }
  }

  return summarizePhase({
    items: workload.pointKeys.length,
    itemUnit: 'queries',
    samples,
    sampleUnit: 'query',
    durationMs: performance.now() - started,
  })
}

async function rangeQueryPhase(database, workload) {
  const samples = []
  const started = performance.now()
  for (const lower of workload.rangeStarts) {
    const upper = lower + workload.rangeWidth
    const rows = await measuredCall(
      samples,
      () => database.execute(
        `SELECT ordinal, key FROM benchmark_documents
          WHERE ordinal >= ? AND ordinal < ?
          ORDER BY ordinal`,
        [lower, upper],
      ),
    )
    if (rows.length !== workload.rangeWidth) {
      throw new Error(`Range-query verification failed for [${lower}, ${upper})`)
    }
  }

  return summarizePhase({
    items: workload.rangeStarts.length,
    itemUnit: 'queries',
    samples,
    sampleUnit: 'query',
    durationMs: performance.now() - started,
  })
}

async function updatePhase(database, workload) {
  const samples = []
  const started = performance.now()
  for (let index = 0; index < workload.updateKeys.length; index++) {
    const key = workload.updateKeys[index]
    const rows = await measuredCall(
      samples,
      () => database.execute(
        'UPDATE benchmark_documents SET revision = ? WHERE key = ?',
        [index + 1, key],
      ),
    )
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(`Update verification failed for ${key}`)
    }
  }

  return summarizePhase({
    items: workload.updateKeys.length,
    itemUnit: 'updates',
    samples,
    sampleUnit: 'update',
    durationMs: performance.now() - started,
  })
}

async function cacheChurnPhase(database, configuration) {
  const collections = Array.from(
    { length: configuration.cacheChurnCollections },
    (_, index) => `benchmark_cache_${String(index).padStart(5, '0')}`,
  )
  for (const [index, collection] of collections.entries()) {
    await database.execute(`INSERT INTO ${collection}`, {
      key: 'sentinel',
      collectionOrdinal: index,
    })
  }

  const samples = []
  const started = performance.now()
  for (let index = 0; index < configuration.cacheChurnQueries; index++) {
    const collection = collections[index % collections.length]
    const rows = await measuredCall(
      samples,
      () => database.execute(`SELECT key FROM ${collection} WHERE key = ?`, ['sentinel']),
    )
    if (rows.length !== 1 || rows[0].key !== 'sentinel') {
      throw new Error(`Cache-churn verification failed for ${collection}`)
    }
  }

  return summarizePhase({
    items: configuration.cacheChurnQueries,
    itemUnit: 'queries',
    samples,
    sampleUnit: 'query',
    setupItems: collections.length,
    durationMs: performance.now() - started,
  })
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  return packageJson.version
}

async function environmentMetadata(sqliteVersion) {
  const cpu = os.cpus()[0]
  return {
    node: process.version,
    v8: process.versions.v8,
    uv: process.versions.uv,
    napi: process.versions.napi,
    sqlite: sqliteVersion,
    packageVersion: await packageVersion(),
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpuModel: cpu?.model?.trim() ?? null,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  }
}

async function runBenchmark(configuration) {
  const storage = await prepareStorage(configuration)
  const startedAt = new Date()
  const overallStarted = performance.now()
  let database
  let primaryError = null

  try {
    const documents = createDocuments(configuration)
    const workload = createWorkload(configuration)
    const databaseOptions = {
      storagePath: storage.storagePath,
      busyTimeoutMs: configuration.busyTimeoutMs,
      durability: configuration.durability,
      fieldIndexes: fieldIndexPolicy(configuration.fieldIndexes),
    }
    // In-memory collections cannot be evicted because reopening one would lose
    // its data. The public API therefore deliberately rejects this option for
    // :memory:, while disk benchmarks exercise the configured LRU limit.
    if (storage.kind !== 'memory') {
      databaseOptions.maxOpenCollections = configuration.maxOpenCollections
    }
    database = createIdb(databaseOptions)
    const phases = {
      insert: await insertPhase(database, documents, configuration),
      pointQuery: await pointQueryPhase(database, workload),
      rangeQuery: await rangeQueryPhase(database, workload),
      update: await updatePhase(database, workload),
      cacheChurn: await cacheChurnPhase(database, configuration),
    }
    const [sqliteRuntime] = await database.execute(
      'QUERY ON benchmark_documents SELECT sqlite_version() AS sqliteVersion',
    )
    const environment = await environmentMetadata(sqliteRuntime.sqliteVersion)
    const databaseToClose = database
    database = null
    await databaseToClose.close()

    const finishedAt = new Date()
    return {
      formatVersion: BENCHMARK_FORMAT_VERSION,
      benchmark: 'node-idb',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      totalDurationMs: rounded(performance.now() - overallStarted),
      environment,
      configuration: {
        preset: configuration.preset,
        documents: configuration.documents,
        insertBatchSize: configuration.insertBatchSize,
        pointQueries: configuration.pointQueries,
        rangeQueries: configuration.rangeQueries,
        requestedRangeWidth: configuration.rangeWidth,
        rangeWidth: workload.rangeWidth,
        updates: configuration.updates,
        warmupQueries: configuration.warmupQueries,
        cacheChurnCollections: configuration.cacheChurnCollections,
        cacheChurnQueries: configuration.cacheChurnQueries,
        payloadBytes: configuration.payloadBytes,
        seed: configuration.seed,
        databaseOptions: {
          busyTimeoutMs: configuration.busyTimeoutMs,
          durability: configuration.durability,
          fieldIndexes: configuration.fieldIndexes,
          maxOpenCollections: storage.kind === 'memory'
            ? null
            : configuration.maxOpenCollections,
        },
      },
      storage: {
        kind: storage.kind,
        path: storage.storagePath,
        retained: storage.retained,
      },
      phases,
      notes: [
        'Document generation, query selection, warmups, and cache-churn setup are excluded from phase timings.',
        'Latency percentiles summarize individual API calls; insert latency samples are batches.',
        'Use identical configuration and comparable idle hardware when comparing reports.',
      ],
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const finalizationErrors = []
    try {
      await database?.close()
    } catch (error) {
      finalizationErrors.push(error)
    }
    try {
      await storage.cleanup()
    } catch (error) {
      finalizationErrors.push(error)
    }
    if (finalizationErrors.length) {
      const errors = primaryError
        ? [primaryError, ...finalizationErrors.filter((error) => error !== primaryError)]
        : finalizationErrors
      if (errors.length === 1) throw errors[0]
      throw new AggregateError(errors, 'The benchmark failed and could not fully finalize its database')
    }
  }
}

function formatNumber(value, fractionDigits = 1) {
  if (value === null || value === undefined) return '-'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: fractionDigits }).format(value)
}

function pad(value, width, direction = 'end') {
  return direction === 'start'
    ? String(value).padStart(width)
    : String(value).padEnd(width)
}

function printHuman(report) {
  const configuration = report.configuration
  const storage = report.storage
  console.log(`node-idb ${report.environment.packageVersion} benchmark (${configuration.preset})`)
  console.log(`Node ${report.environment.node} | SQLite ${report.environment.sqlite} | ${report.environment.platform} ${report.environment.architecture}`)
  console.log(`CPU: ${report.environment.cpuModel ?? 'unknown'} (${report.environment.logicalCpuCount} logical cores)`)
  const maximumOpenCollections = configuration.databaseOptions.maxOpenCollections ?? 'not applicable'
  console.log(`Seed: ${configuration.seed} | durability: ${configuration.databaseOptions.durability} | field indexes: ${configuration.databaseOptions.fieldIndexes} | max open collections: ${maximumOpenCollections}`)
  const storageDisposition = storage.kind === 'memory'
    ? ' (ephemeral)'
    : storage.retained
      ? ' (retained)'
      : ' (removed after run)'
  console.log(`Storage: ${storage.kind} ${storage.path}${storageDisposition}`)
  console.log('')

  const headers = ['Phase', 'Items', 'Calls', 'Total ms', 'Items/s', 'p50 ms', 'p95 ms', 'p99 ms']
  const rows = Object.entries(report.phases).map(([name, phase]) => [
    name,
    formatNumber(phase.items, 0),
    formatNumber(phase.measuredCalls, 0),
    formatNumber(phase.durationMs, 3),
    formatNumber(phase.throughputPerSecond, 1),
    formatNumber(phase.latencyMs.p50, 3),
    formatNumber(phase.latencyMs.p95, 3),
    formatNumber(phase.latencyMs.p99, 3),
  ])
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length),
  ))
  console.log(headers.map((header, index) => pad(header, widths[index])).join('  '))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    console.log(row.map((value, index) => pad(value, widths[index], index === 0 ? 'end' : 'start')).join('  '))
  }
  console.log('')
  console.log(`Total wall time: ${formatNumber(report.totalDurationMs, 3)} ms`)
  console.log('Cache-churn collection setup is excluded; insert latency is measured per batch.')
}

async function writeReport(report, configuration) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (configuration.format === 'json') process.stdout.write(json)
  else printHuman(report)

  if (configuration.output) {
    const output = path.resolve(configuration.output)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, json, 'utf8')
    if (configuration.format === 'human') console.log(`JSON report: ${output}`)
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2))
  if (parsed.help) {
    process.stdout.write(usage())
    return
  }
  const report = await runBenchmark(parsed.configuration)
  await writeReport(report, parsed.configuration)
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
