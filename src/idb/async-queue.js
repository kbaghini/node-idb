// A one-item asynchronous queue. Keeping at most one unread batch gives
// stream consumers real backpressure instead of buffering an entire query.
export function createAsyncQueue() {
  /** @type {unknown[]} */
  const items = []
  /** @type {Array<{ resolve(value: IteratorResult<unknown>): void, reject(error: unknown): void }>} */
  const readers = []
  /** @type {Array<{ value: unknown, resolve(value?: unknown): void, reject(error: unknown): void }>} */
  const writers = []
  let closed = false
  let failure

  function promoteWriter() {
    if (closed || items.length || !writers.length) return
    const writer = writers.shift()
    if (!writer) return
    const reader = readers.shift()
    if (reader) reader.resolve({ value: writer.value, done: false })
    else items.push(writer.value)
    writer.resolve()
  }

  return {
    push(value) {
      if (closed) return Promise.reject(failure || new Error('The stream consumer closed.'))
      const reader = readers.shift()
      if (reader) {
        reader.resolve({ value, done: false })
        return Promise.resolve()
      }
      if (!items.length) {
        items.push(value)
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => writers.push({ value, resolve, reject }))
    },
    next() {
      if (items.length) {
        const value = items.shift()
        promoteWriter()
        return Promise.resolve({ value, done: false })
      }
      if (failure) return Promise.reject(failure)
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve, reject) => readers.push({ resolve, reject }))
    },
    close(error) {
      if (closed) return
      closed = true
      failure = error
      const rejected = error || new Error('The stream consumer closed.')
      for (const writer of writers.splice(0)) writer.reject(rejected)
      for (const reader of readers.splice(0)) {
        if (error) reader.reject(error)
        else reader.resolve({ value: undefined, done: true })
      }
    },
  }
}
