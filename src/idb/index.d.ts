export interface IdbOptions {
  /** Root containing one directory per project. Defaults to `<cwd>/idbs`. */
  storagePath?: string;
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
    project: string,
    statement: string,
    parameters?: TParameters,
  ): Promise<TResult>;

  /** Compatibility API: always resolves an `{ error, result }` envelope. */
  run<TResult = unknown>(
    project: string,
    statement: string,
  ): Promise<IdbOutcome<TResult>>;
  run<TResult = unknown>(
    project: string,
    statement: string,
    callback: IdbCallback<TResult>,
  ): Promise<IdbOutcome<TResult>>;
  run<TResult = unknown, TParameters = unknown>(
    project: string,
    statement: string,
    parameters: TParameters,
    callback?: IdbCallback<TResult>,
  ): Promise<IdbOutcome<TResult>>;

  /** Closes one project's collections, or every open collection when omitted. */
  close(project?: string): Promise<void>;
}

export function createIdb(options?: IdbOptions): Readonly<IdbEngine>;

declare const idb: Readonly<IdbEngine>;
export default idb;
