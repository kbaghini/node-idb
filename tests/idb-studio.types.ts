import {
  decodeStudioValue,
  encodeStudioValue,
  startStudio,
  type StudioHandle,
  type StudioOptions,
  type StudioState,
  type StudioWireValue,
} from 'node-idb/studio'

const options = {
  rootPath: './idbs',
  port: 0,
  writable: true,
  maxRows: 250,
  bodyLimitBytes: 1_048_576,
  queryTimeoutMs: 5_000,
} satisfies StudioOptions

const wire: StudioWireValue = encodeStudioValue({
  createdAt: new Date(),
  count: 9_007_199_254_740_993n,
  bytes: new Uint8Array([1, 2, 3]),
})
const decoded: unknown = decodeStudioValue(wire)
void decoded

const studio: StudioHandle = await startStudio(options)
const state: StudioState = await studio.refresh()
const host: '127.0.0.1' = studio.host
const port: number = studio.port
const closed: boolean = studio.closed
const collections: readonly string[] = state.databases.flatMap((database) =>
  database.collections.map((collection) => collection.name),
)
void host
void port
void closed
void collections
await studio.close()

// @ts-expect-error rootPath is required
await startStudio({ port: 0 })

// @ts-expect-error Studio never accepts a remote binding host
await startStudio({ rootPath: './idbs', host: '0.0.0.0' })

// @ts-expect-error maxRows is numeric
await startStudio({ rootPath: './idbs', maxRows: '500' })

// @ts-expect-error a number wire node cannot carry an arbitrary string
const invalidWire: StudioWireValue = ['number', 'one']
void invalidWire
