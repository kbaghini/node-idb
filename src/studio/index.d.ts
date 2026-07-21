export interface StudioCodecLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
  maxBinaryBytes?: number;
}

export type StudioWireValue =
  | readonly ["null"]
  | readonly ["undefined"]
  | readonly ["boolean", boolean]
  | readonly ["number", number | "NaN" | "Infinity" | "-Infinity"]
  | readonly ["string", string]
  | readonly ["bigint", string]
  | readonly ["date", string]
  | readonly ["binary", string]
  | readonly ["array", readonly StudioWireValue[]]
  | readonly [
      "object",
      readonly (readonly [string, StudioWireValue])[],
    ];

export function encodeStudioValue(
  value: unknown,
  options?: StudioCodecLimits,
): StudioWireValue;

export function decodeStudioValue(
  value: unknown,
  options?: StudioCodecLimits,
): unknown;

export interface StudioOptions {
  /** Directory containing a node-idb database and/or immediate child databases. */
  rootPath: string;
  /** Local TCP port. Use 0 to let the operating system choose one. Defaults to 4177. */
  port?: number;
  /** Enables dedicated mutation and maintenance endpoints. Defaults to false. */
  writable?: boolean;
  /** Maximum rows returned by one query or document page. Defaults to 500. */
  maxRows?: number;
  /** Maximum JSON request body size in bytes. Defaults to 2 MiB. */
  bodyLimitBytes?: number;
  /** Maximum database operation duration in milliseconds. Defaults to 10 seconds. */
  queryTimeoutMs?: number;
}

export interface StudioCollectionState {
  readonly name: string;
  readonly schemaVersion: number;
  readonly totalBytes: number;
  readonly fieldIndexes: unknown;
}

export interface StudioDatabaseState {
  readonly id: string;
  readonly name: string;
  readonly location: "root" | "child";
  readonly totalBytes: number;
  readonly collectionCount: number;
  readonly collections: readonly StudioCollectionState[];
}

export interface StudioState {
  readonly writable: boolean;
  readonly rootPath: string;
  readonly scannedAt: string;
  readonly catalogVersion: number;
  readonly discovery: "root-and-immediate-children";
  readonly limits: Readonly<{
    maxRows: number;
    bodyLimitBytes: number;
    maxResponseBytes: number;
    queryTimeoutMs: number;
  }>;
  readonly databases: readonly StudioDatabaseState[];
  readonly errors: readonly Readonly<{ name: string; message: string }>[];
}

export interface StudioHandle {
  /** Launch URL. The random bearer token is carried only in its URL fragment. */
  readonly url: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly rootPath: string;
  readonly writable: boolean;
  readonly closed: boolean;
  refresh(): Promise<StudioState>;
  close(): Promise<void>;
}

/** Starts a token-protected Studio bound exclusively to 127.0.0.1. */
export function startStudio(options: StudioOptions): Promise<StudioHandle>;
