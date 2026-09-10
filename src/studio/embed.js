export function normalizeBasePath(value = '/') {
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) {
    throw new TypeError('basePath must start and end with / and contain only simple path segments')
  }
  return value
}

function origin(value) {
  if (typeof value !== 'string') throw new TypeError('Embed origins must be exact HTTP(S) origins')
  const url = new URL(value)
  if (url.origin !== value || url.username || url.password || url.hostname.includes('*') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new TypeError('Use an exact HTTPS origin (HTTP is allowed only for localhost development)')
  }
  return value
}

export function normalizeEmbed(value) {
  if (value === undefined || value === false) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('embed must be a configuration object')
  for (const key of Object.keys(value)) if (!['publicOrigin', 'allowedParents', 'authenticate', 'hideHeader', 'hideNavigator'].includes(key)) throw new TypeError(`Unknown embed option: ${key}`)
  if (typeof value.authenticate !== 'function') throw new TypeError('embed.authenticate is required')
  if (!Array.isArray(value.allowedParents) || !value.allowedParents.length || value.allowedParents.length > 20) throw new TypeError('embed.allowedParents must contain 1–20 exact origins')
  for (const key of ['hideHeader', 'hideNavigator']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError(`embed.${key} must be a boolean`)
  return Object.freeze({ publicOrigin: origin(value.publicOrigin), allowedParents: Object.freeze([...new Set(value.allowedParents.map(origin))]),
    authenticate: value.authenticate, hideHeader: value.hideHeader !== false, hideNavigator: value.hideNavigator === true })
}

export function normalizeAccess(value) {
  if (value === null || value === false || value === undefined) return null
  if (!value || typeof value !== 'object' || typeof value.subject !== 'string' || !value.subject || value.subject.length > 256 ||
      !Array.isArray(value.databases) || value.databases.length > 10000 ||
      value.databases.some(name => typeof name !== 'string' || (name !== '.' && !/^[A-Za-z0-9_-]{1,128}$/.test(name))) ||
      (value.writable !== undefined && typeof value.writable !== 'boolean')) throw new TypeError('Invalid Studio access grant')
  return Object.freeze({ subject: value.subject, databases: Object.freeze([...new Set(value.databases)]), writable: value.writable === true })
}

export async function authenticateEmbed(configuration, request, signal) {
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return normalizeAccess(await Promise.race([Promise.resolve().then(() => configuration.authenticate(request, { signal })), aborted]))
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
