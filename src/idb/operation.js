const MAX_TIMEOUT_MS = 2_147_483_647;

export function validateAbortSignal(signal, label = 'signal') {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError(`${label} must be an AbortSignal.`);
  }
}

export function validateTimeoutMs(timeoutMs, label = 'timeoutMs') {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new RangeError(`${label} must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}.`);
  }
}

export function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return reason;
  }

  const error = new Error('The operation was aborted.', reason === undefined ? undefined : { cause: reason });
  error.name = 'AbortError';
  Object.defineProperty(error, 'code', { value: 'ABORT_ERR', enumerable: true })
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

/** @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] */
export function createOperationScope(options = {}) {
  const { signal, timeoutMs } = options
  validateAbortSignal(signal);
  validateTimeoutMs(timeoutMs);

  const controller = new AbortController();
  let timer;
  let disposed = false;

  const forwardAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) {
      forwardAbort();
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(() => {
      const error = new Error(`The operation exceeded its ${timeoutMs} ms deadline.`);
      error.name = 'TimeoutError';
      Object.defineProperty(error, 'code', { value: 'IDB_TIMEOUT', enumerable: true })
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    },
  }
}

export async function withDatabaseInterrupt(database, signal, operation) {
  throwIfAborted(signal);

  const interrupt = () => {
    try {
      database.interrupt()
    } catch {
      // The statement may have completed concurrently with cancellation.
    }
  };
  signal?.addEventListener('abort', interrupt, { once: true });

  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }
}
