import { createServer, request as proxyRequest } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createIdb } from 'node-idb'
import { startStudio } from 'node-idb/studio'

// Local integration demo only. Production must use your application's verified
// sessions and authorization store instead of automatically issuing a demo cookie.
const rootPath = './.example-data/embedded-studio'
for (const name of ['demo', 'private']) {
  const engine = createIdb({ storagePath: `${rootPath}/${name}` })
  try {
    await engine.execute('INSERT IF ABSENT INTO products WHERE sku = $sku',
      { sku: 'A-100', name: 'Mechanical keyboard', price: 129, updatedAt: new Date('2026-01-01') })
  } finally { await engine.close() }
}

const session = randomBytes(32).toString('hex')
let studio
const page = await readFile(new URL('./index.html', import.meta.url))
const app = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': `studio_demo=${session}; HttpOnly; SameSite=Strict; Path=/`,
      'Content-Security-Policy': "default-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    })
    response.end(page)
    return
  }
  if (!studio || !request.url?.startsWith('/admin/studio/')) { response.writeHead(404); response.end(); return }
  // Preserve the mount prefix, Host, Origin and cookie headers. Never trust
  // identity headers from the browser; Studio verifies the session itself.
  const outgoing = proxyRequest({ hostname: '127.0.0.1', port: studio.port, path: request.url,
    method: request.method, headers: { ...request.headers, connection: 'close' } }, upstream => {
    response.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.pipe(response)
  })
  outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
  response.on('close', () => outgoing.destroy())
  request.pipe(outgoing)
})
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${app.address().port}`
try {
  studio = await startStudio({ rootPath, basePath: '/admin/studio/', port: 0,
    embed: { publicOrigin: origin, allowedParents: [origin], hideHeader: true,
      authenticate(request) {
        const cookie = request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('studio_demo='))?.slice('studio_demo='.length) || ''
        const candidate = Buffer.from(cookie), expected = Buffer.from(session)
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null
        return { subject: 'local-demo-viewer', databases: ['demo'], writable: false }
      } },
  })
} catch (error) { app.close(); throw error }
console.log(`Embedded Studio demo: ${origin}/`)
console.log('Local demo session: read-only access to demo. The private database is not accessible.')
const close = async () => { app.close(); app.closeIdleConnections?.(); await studio.close() }
process.once('SIGINT', close)
process.once('SIGTERM', close)
