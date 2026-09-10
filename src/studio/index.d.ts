import type { SqliteCacheOptions } from '../idb/index.js';
import type { IncomingMessage } from 'node:http';

export interface StudioAccess {
  /** Stable user/session identity, obtained from verified server-side authentication. */
  subject: string;
  /** Exact immediate directory names beneath rootPath. Use '.' for the root database. */
  databases: readonly string[];
  /** May enable writes only if the Studio instance also has writable: true. */
  writable?: boolean;
}

export interface StudioEmbedOptions {
  /** Browser-facing exact HTTPS origin; HTTP localhost is allowed for development. */
  publicOrigin: string;
  /** Exact origins allowed to frame Studio; wildcards are not accepted. */
  allowedParents: readonly [string, ...string[]];
  /** Verify a host-app session on every request. Return null to deny access. */
  authenticate(request: IncomingMessage, context: { signal: AbortSignal }): StudioAccess | null | Promise<StudioAccess | null>;
  /** Hide the standalone header; defaults to true. */
  hideHeader?: boolean;
  /** Hide the navigator; this is cosmetic and never grants/restricts access. */
  hideNavigator?: boolean;
}

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
  /** Mount prefix with leading and trailing slashes. Default '/'. */
  basePath?: string;
  /** Opt-in iframe mode using host-app authentication instead of the launch token. */
  embed?: StudioEmbedOptions | false;
  /** Managed backup directory outside rootPath. Omit to disable backup actions. */
  backupPath?: string;
  /** Transfer/comparison document cap per collection. Default 10000, maximum 100000. */
  maxTransferRows?: number;
  /** Connection-local page-cache and mapping settings for each opened database. */
  sqliteCache?: SqliteCacheOptions;
  /** Retained collection connections per database. Default: 16; maximum: 10000. */
  maxOpenCollections?: number;
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
  readonly embed: boolean;
  readonly backupsEnabled: boolean;
  readonly version: string;
  readonly writable: boolean;
  readonly rootPath: string;
  readonly scannedAt: string;
  readonly catalogVersion: number;
  readonly discovery: "root-and-immediate-children";
  readonly limits: Readonly<{
    maxRows: number;
    maxTransferRows: number;
    bodyLimitBytes: number;
    maxResponseBytes: number;
    queryTimeoutMs: number;
  }>;
  readonly databases: readonly StudioDatabaseState[];
  readonly errors: readonly Readonly<{ name: string; message: string }>[];
}

export interface StudioHandle {
  /** Local launch URL with a fragment token, or the public URL in embed mode. */
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
