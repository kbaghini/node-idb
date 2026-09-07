import { createIdb, type SqliteCacheOptions } from 'node-idb'
import { startStudio, type StudioOptions } from 'node-idb/studio'

const cache: SqliteCacheOptions = { mainKiB: 1024, blobKiB: 512, mmapBytes: 0 }
const db = createIdb({ storagePath: './data', sqliteCache: cache })
const rows: AsyncIterable<{ id: number }> = db.stream<{ id: number }>('SELECT id FROM records')
const options: StudioOptions = { rootPath: './data', port: 0, sqliteCache: cache, maxOpenCollections: 2 }
void rows
void db.diagnostics().then((result) => result.sqliteCache.mainKiB)
void startStudio(options)
