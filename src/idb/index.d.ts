export type IdbDurability = "strict" | "balanced";
export type IdbMode = "readwrite" | "readonly";

export interface FieldIndexPathRule {
  collection: string;
  path: string;
  enabled: boolean;
  pattern?: never;
}

export interface FieldIndexPatternRule {
  collection: string;
  pattern: string;
  enabled: boolean;
  path?: never;
}

export type FieldIndexRule = FieldIndexPathRule | FieldIndexPatternRule;
export type AutoIndexPreset = "conservative" | "balanced" | "aggressive";

export interface AutoFieldIndexes {
  mode: "auto";
  preset?: AutoIndexPreset;
  maxIndexesPerCollection?: number;
  minDocuments?: number;
  minQueryCount?: number;
  slowQueryMs?: number;
  maxResultRatio?: number;
  evaluationInterval?: number;
  cooldownMs?: number;
  allowDrop?: boolean;
  dropUnusedAfterMs?: number;
  minIndexAgeMs?: number;
  /** Hard overrides. Matching enabled/disabled rules are never auto-managed. */
  rules?: readonly FieldIndexRule[];
}

export type FieldIndexes = "auto" | "all" | "none" | AutoFieldIndexes | {
  default?: "all" | "none";
  rules?: readonly FieldIndexRule[];
};

export interface IdbBaseOptions<TStoragePath extends string> {
  /** One database directory. Relative paths resolve when createIdb is called. */
  storagePath: TStoragePath;
  /** How long SQLite waits for a conflicting lock. Defaults to 10,000 ms. */
  busyTimeoutMs?: number;
  /** Maximum disk collection connections retained by this engine. Defaults to 16. */
  maxOpenCollections?: string extends TStoragePath
    ? never
    : TStoragePath extends ":memory:" ? never : number;
}

export interface IdbReadwriteOptions<TStoragePath extends string>
  extends IdbBaseOptions<TStoragePath> {
  /** Opens storage for reads and writes. This is the default mode. */
  mode?: "readwrite";
  /** `strict` uses FULL synchronization; `balanced` uses NORMAL. */
  durability?: IdbDurability;
  /** Controls optional predicate indexes. New storage defaults to adaptive `auto`. */
  fieldIndexes?: FieldIndexes;
}

export type IdbReadonlyOptions<TStoragePath extends string> =
  string extends TStoragePath ? never
    : TStoragePath extends ":memory:" ? never : IdbBaseOptions<TStoragePath> & {
  /** Opens existing version-5 storage without changing it. */
  mode: "readonly";
  /** Read-only engines perform no writes, so durability is not configurable. */
  durability?: never;
  /** Read-only engines use the index policy already persisted by a writer. */
  fieldIndexes?: never;
};

export type IdbMemoryOptions = IdbReadwriteOptions<":memory:">;
/** Options safe when the path is a runtime `string` that may equal `:memory:`. */
export type IdbDynamicOptions = IdbReadwriteOptions<string>;
export type IdbFilesystemOptions<TStoragePath extends string> =
  string extends TStoragePath ? never
    : TStoragePath extends ":memory:" ? never
      : IdbReadwriteOptions<TStoragePath> | IdbReadonlyOptions<TStoragePath>;
export type IdbOptions<TStoragePath extends string> = {
  storagePath: TStoragePath;
} & (
  string extends TStoragePath ? IdbDynamicOptions
    : TStoragePath extends ":memory:" ? IdbMemoryOptions
      : IdbFilesystemOptions<TStoragePath>
);

type NonMemoryStoragePath<TStoragePath extends string> =
  string extends TStoragePath ? never
    : TStoragePath extends ":memory:" ? never : TStoragePath;

export interface BackupOptions {
  destinationPath: string;
  overwrite?: boolean;
  integrityCheck?: "quick" | "full";
  signal?: AbortSignal;
  collections?: readonly [string, ...string[]];
}

export interface BackupFile {
  readonly collection: string;
  readonly kind: "collection" | "blobs";
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupResult {
  readonly destinationPath: string;
  readonly createdAt: string;
  readonly collections: readonly string[];
  readonly files: readonly BackupFile[];
}

export interface ExecutionOptions {
  /** Cooperatively cancels queued or running SQLite work. */
  signal?: AbortSignal;
  /** Aborts the operation after this many milliseconds. */
  timeoutMs?: number;
}

export interface ExecuteOptions extends ExecutionOptions {
  /** Prevents UPSERT INTO or REPLACE INTO from inserting when its selector has no match. */
  requireMatch?: boolean;
}

export interface StreamOptions extends ExecutionOptions {
  /** Rows/documents fetched per SQLite page. Defaults to 100; maximum 10,000. */
  batchSize?: number;
}

export interface CollectionOperationOptions extends ExecutionOptions {
  /** Restricts the operation to these existing collections. */
  collections?: readonly [string, ...string[]];
}

export interface CollectionStructureOptions extends ExecutionOptions {
  /** Exact canonical field path, such as `contact.details`; omit for the whole collection. */
  path?: string;
}

export type ObservedValueType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "binary"
  | "null";

export interface CollectionStructureType {
  readonly type: ObservedValueType;
  readonly count: number;
}

export interface CollectionStructureNode {
  /** Leaf field name, or the collection name for the complete structure root. */
  readonly name: string;
  /** Canonical dot path. The complete collection root uses an empty path. */
  readonly path: string;
  /** Absolute nesting depth: collection root 0, top-level field 1. */
  readonly depth: number;
  /** Logical types observed in current stored values, with exact document counts. */
  readonly types: readonly CollectionStructureType[];
  readonly presentInDocuments: number;
  /** Presence divided by all documents in the collection. */
  readonly coverage: number;
  /** Whether the field is absent from at least one collection document. */
  readonly optional: boolean;
  /** Presence divided by parent values observed as objects. */
  readonly coverageWithinParent: number;
  /** Whether the field is absent from at least one parent value observed as an object. */
  readonly optionalWithinParent: boolean;
  /** Whether the field currently has a physical predicate index. */
  readonly indexed: boolean;
  readonly children: readonly CollectionStructureNode[];
}

export interface CollectionStructure {
  readonly collection: string;
  /** Requested canonical sub-field path, or null for the complete collection. */
  readonly path: string | null;
  readonly documentCount: number;
  /** Returned field nodes; excludes the synthetic collection root for a complete structure. */
  readonly fieldCount: number;
  /** Greatest absolute nesting depth in the returned tree. */
  readonly maxDepth: number;
  readonly root: CollectionStructureNode;
}

export interface BackupVerificationResult {
  readonly backupPath: string;
  readonly manifestSha256: string;
  readonly integrityCheck: "quick" | "full";
  readonly createdAt: string;
  readonly nodeIdbVersion: string;
  readonly sqliteVersion: string;
  readonly collections: readonly string[];
  readonly files: readonly BackupFile[];
}

export interface RestoreBackupOptions {
  backupPath: string;
  destinationPath: string;
  overwrite?: boolean;
  integrityCheck?: "quick" | "full";
  signal?: AbortSignal;
}

export interface RestoreBackupResult {
  readonly backupPath: string;
  readonly destinationPath: string;
  readonly replaced: boolean;
  readonly integrityCheck: "quick" | "full";
  readonly collections: readonly string[];
  readonly files: readonly BackupFile[];
}

export interface CollectionDiagnostics {
  readonly collection: string;
  readonly schemaVersion: number;
  readonly mode: IdbMode;
  readonly fields: number;
  readonly fieldIndexes: unknown;
  readonly databasePath: string;
  readonly blobPath: string;
  readonly autoIndexing: AutoIndexDiagnostics;
  readonly leases: number;
  readonly lastUsed: number;
}

export interface AutoIndexCandidate {
  readonly fieldId: number;
  readonly path: string;
  readonly state: "pinned-enabled" | "pinned-disabled" | "managed" | "candidate" | "observing";
  readonly score: number;
  readonly queryCount: number;
  readonly equalityCount: number;
  readonly rangeCount: number;
  readonly orderCount: number;
  readonly otherCount: number;
  readonly averageDurationMs: number;
  readonly averageResultRows: number;
  readonly resultRatio: number;
  readonly lastSeenAt: number;
  readonly eligible: boolean;
}

export interface ManagedAutoIndex {
  readonly fieldId: number;
  readonly path: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly reason: string;
  readonly score: number;
}

export interface AutoIndexAction {
  readonly type: "create" | "drop";
  readonly fieldId: number;
  readonly path: string;
  readonly score: number;
  readonly reason: string;
}

export interface AutoIndexDiagnostics {
  readonly mode: "manual" | "auto";
  readonly preset?: AutoIndexPreset | null;
  readonly pendingQueries: number;
  readonly observedQueries: number;
  readonly managedIndexes: readonly ManagedAutoIndex[];
  readonly candidates: readonly AutoIndexCandidate[];
  readonly proposedAction?: AutoIndexAction | null;
  readonly lastEvaluationAt: number | null;
  readonly lastChangeAt: number | null;
  readonly lastError: string | null;
}

export interface OptimizeIndexesOptions extends CollectionOperationOptions {
  /** Reports the next safe action without changing schema. */
  dryRun?: boolean;
}

export interface OptimizeIndexesResult {
  readonly collection: string;
  readonly mode: "manual" | "auto";
  readonly dryRun: boolean;
  readonly documents: number;
  readonly action: AutoIndexAction | null;
  readonly changed: AutoIndexAction | null;
  readonly candidates: readonly AutoIndexCandidate[];
  readonly managedIndexes: readonly ManagedAutoIndex[];
}

export interface IdbDiagnostics {
  readonly storagePath: string;
  readonly mode: IdbMode;
  readonly state: "open" | "closing" | "closed";
  readonly schemaVersion: number;
  readonly busyTimeoutMs: number;
  readonly durability: IdbDurability | null;
  readonly fieldIndexes: unknown;
  readonly operations: Readonly<{ active: number }>;
  readonly cache: Readonly<{
    limit: number | null;
    open: number;
    waiting: number;
    evictions: number;
  }>;
  readonly collections: readonly string[];
  readonly openCollections: readonly CollectionDiagnostics[];
}

export interface MaintenanceResult {
  readonly collection: string;
  readonly operation: "analyze" | "vacuum";
  readonly durationMs: number;
}

export interface DatabaseFileStats {
  readonly pageCount: number;
  readonly pageSize: number;
  readonly freePages: number;
  readonly allocatedBytes: number;
  readonly reclaimableBytes: number;
}

export interface CollectionStorageStats {
  readonly collection: string;
  readonly files: Readonly<{ collection: number | null; blobs: number | null }>;
  readonly main: DatabaseFileStats;
  readonly blobs: DatabaseFileStats;
}

export interface StorageStats {
  readonly storagePath: string;
  readonly fileBytes: number | null;
  readonly reclaimableBytes: number;
  readonly collections: readonly CollectionStorageStats[];
}

export interface StorageInspection {
  readonly storagePath: string;
  readonly integrityCheck: "none" | "quick" | "full";
  readonly totalBytes: number;
  readonly collections: readonly Readonly<{
    collection: string;
    schemaVersion: number;
    fieldIndexes: unknown;
    files: Readonly<{
      collection: Readonly<{ path: string; bytes: number }>;
      blobs: Readonly<{ path: string; bytes: number }>;
    }>;
  }>[];
}

export interface MutationRow {
  object_id: number;
  inserted?: true;
}

export type IdbOutcome<TResult> =
  | { error: null; result: TResult }
  | { error: unknown; result: undefined };

export type IdbCallback<TResult> = (
  error: unknown | null,
  result?: TResult,
) => void;

export interface IdbEngine {
  /** Throwing API: resolves the direct result and rejects errors. */
  execute<TResult = unknown, TParameters = unknown>(
    statement: string,
    parameters?: TParameters,
    options?: ExecuteOptions,
  ): Promise<TResult>;

  /** Incrementally reads projected rows or complete `SELECT *` documents with backpressure. */
  stream<TResult = unknown, TParameters = unknown>(
    statement: string,
    parameters?: TParameters,
    options?: StreamOptions,
  ): AsyncIterable<TResult>;

  /** Compatibility API: always resolves an `{ error, result }` envelope. */
  run<TResult = unknown>(
    statement: string,
  ): Promise<IdbOutcome<TResult>>;
  /** @deprecated Use `execute()` or the Promise overload. Retained through 0.x. */
  run<TResult = unknown>(
    statement: string,
    callback: IdbCallback<TResult>,
  ): Promise<IdbOutcome<TResult>>;
  run<TResult = unknown, TParameters = unknown>(
    statement: string,
    parameters: TParameters,
  ): Promise<IdbOutcome<TResult>>;
  /** @deprecated Use `execute()` or the Promise overload. Retained through 0.x. */
  run<TResult = unknown, TParameters = unknown>(
    statement: string,
    parameters: TParameters,
    callback: IdbCallback<TResult>,
  ): Promise<IdbOutcome<TResult>>;

  /** Creates a verified, manifested backup without exposing partial output. */
  backup(options: BackupOptions): Promise<BackupResult>;

  /** Reports the immutable observed shape of one existing collection or sub-field. */
  structure(
    collection: string,
    options?: CollectionStructureOptions,
  ): Promise<CollectionStructure>;

  diagnostics(options?: ExecutionOptions): Promise<IdbDiagnostics>;
  analyze(options?: CollectionOperationOptions): Promise<readonly MaintenanceResult[]>;
  vacuum(options?: CollectionOperationOptions): Promise<readonly MaintenanceResult[]>;
  storageStats(options?: CollectionOperationOptions): Promise<StorageStats>;
  optimizeIndexes(options?: OptimizeIndexesOptions): Promise<readonly OptimizeIndexesResult[]>;

  /** Permanently closes this engine after its active operations settle. */
  close(): Promise<void>;
}

export function createIdb(options: IdbMemoryOptions): Readonly<IdbEngine>;
export function createIdb<const TStoragePath extends string>(
  options: IdbFilesystemOptions<TStoragePath> & {
    storagePath: NonMemoryStoragePath<TStoragePath>;
  },
): Readonly<IdbEngine>;
export function createIdb(options: IdbDynamicOptions): Readonly<IdbEngine>;

export function verifyBackup(options: {
  backupPath: string;
  integrityCheck?: "quick" | "full";
  signal?: AbortSignal;
}): Promise<BackupVerificationResult>;

export function restoreBackup(options: RestoreBackupOptions): Promise<RestoreBackupResult>;

export function inspectStorage(options: {
  storagePath: string;
  integrityCheck?: "none" | "quick" | "full";
  signal?: AbortSignal;
}): Promise<StorageInspection>;
