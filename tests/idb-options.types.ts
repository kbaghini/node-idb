// Compile-only public declaration contract. This file is checked by
// `npm run test:types`; it is never executed.
import { createIdb, inspectStorage, restoreBackup, verifyBackup } from '../src/index.js'
import type { CollectionStructure, IdbFilesystemOptions, IdbOptions } from '../src/index.js'

declare const dynamicPath: string
createIdb({ storagePath: ':memory:' })
createIdb({ storagePath: './data', maxOpenCollections: 2 })
createIdb({ storagePath: './data', mode: 'readonly', maxOpenCollections: 2 })
createIdb({ storagePath: dynamicPath, fieldIndexes: 'none' })
createIdb({
  storagePath: dynamicPath,
  fieldIndexes: {
    mode: 'auto',
    preset: 'balanced',
    maxIndexesPerCollection: 20,
    rules: [{ collection: 'users', path: 'email', enabled: true }],
  },
})
// @ts-expect-error Prefer omitting memory-only forbidden properties entirely.
createIdb({ storagePath: ':memory:', maxOpenCollections: undefined })
// @ts-expect-error Prefer omitting readonly-forbidden properties entirely.
createIdb({ storagePath: './data', mode: 'readonly', durability: undefined, fieldIndexes: undefined })

// @ts-expect-error Memory collections cannot be evicted safely.
createIdb({ storagePath: ':memory:', maxOpenCollections: 2 })
// @ts-expect-error Read-only memory storage is not meaningful.
createIdb({ storagePath: ':memory:', mode: 'readonly' })
// @ts-expect-error A broad runtime path cannot safely request a disk-only cap.
createIdb({ storagePath: dynamicPath, maxOpenCollections: 2 })
// @ts-expect-error A broad runtime path cannot safely request read-only disk access.
createIdb({ storagePath: dynamicPath, mode: 'readonly' })
// @ts-expect-error Read-only engines cannot request an index policy.
createIdb({ storagePath: './data', mode: 'readonly', fieldIndexes: 'none' })

// @ts-expect-error A broad runtime path cannot hide read-only memory storage.
const invalidBroad: IdbOptions<string> = { storagePath: ':memory:', mode: 'readonly' }
// @ts-expect-error A typed memory configuration cannot specify an eviction cap.
const invalidMemory: IdbOptions<':memory:'> = { storagePath: ':memory:', maxOpenCollections: 2 }
// @ts-expect-error The memory sentinel is not a filesystem option.
const invalidFilesystem: IdbFilesystemOptions<':memory:'> = { storagePath: ':memory:' }

function accepts<const P extends string>(_options: IdbOptions<P>) {}
// @ts-expect-error Generic inference must not widen away the memory restriction.
accepts({ storagePath: ':memory:', maxOpenCollections: 2 })
// Generic helpers may conservatively omit this explicitly-undefined spelling.
// @ts-expect-error Prefer leaving the optional property out.
accepts({ storagePath: ':memory:', maxOpenCollections: undefined })
accepts({ storagePath: './configured', maxOpenCollections: 2 })

const engine = createIdb({ storagePath: './typed-operations' })
engine.execute('FIND records', [], { signal: new AbortController().signal, timeoutMs: 500 })
engine.execute('REPLACE INTO records WHERE id=$id', { id: 1 }, { requireMatch: true })
const streamed: AsyncIterable<{ id: number }> = engine.stream<{ id: number }>(
  'SELECT id FROM records',
  [],
  { batchSize: 50, timeoutMs: 500 },
)
void streamed
engine.diagnostics()
engine.analyze({ collections: ['records'] })
engine.vacuum({ signal: new AbortController().signal })
engine.storageStats({ collections: ['records'] })
engine.optimizeIndexes({ collections: ['records'], dryRun: true, timeoutMs: 500 })
const observedStructure: Promise<CollectionStructure> = engine.structure('records', {
  path: 'profile.contact',
  timeoutMs: 500,
})
void observedStructure
verifyBackup({ backupPath: './backup', integrityCheck: 'full' })
restoreBackup({ backupPath: './backup', destinationPath: './restored', overwrite: true })
inspectStorage({ storagePath: './data', integrityCheck: 'none' })
// @ts-expect-error batchSize is numeric.
engine.stream('FIND records', [], { batchSize: '50' })
// @ts-expect-error requireMatch is boolean.
engine.execute('REPLACE INTO records WHERE id=1', {}, { requireMatch: 'yes' })
// @ts-expect-error structure paths are canonical strings.
engine.structure('records', { path: 42 })
