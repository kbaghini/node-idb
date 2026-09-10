import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { createIdb } from '../src/index.js'
import { startStudio, encodeStudioValue } from '../src/studio/index.js'

async function fixture(t, overrides = {}) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-embed-test-'))
  for (const tenant of ['alpha', 'beta']) {
    const engine = createIdb({ storagePath: path.join(rootPath, tenant) })
    await engine.execute('INSERT INTO items', { owner: tenant })
    await engine.close()
  }
  const grants = { a: { subject: 'alice', databases: ['alpha'], writable: true }, b: { subject: 'bob', databases: ['beta'], writable: false }, c: { subject: 'charlie', databases: ['alpha'], writable: true } }
  const studio = await startStudio({ rootPath, port: 0, basePath: '/admin/studio/', writable: true,
    embed: { publicOrigin: 'https://app.example.test', allowedParents: ['https://app.example.test'],
      authenticate: async request => {
        await new Promise(resolve => setTimeout(resolve, request.headers.cookie === 'a' ? 10 : 1))
        return grants[request.headers.cookie] || null
      } }, ...overrides })
  t.after(async () => { await studio.close(); await rm(rootPath, { recursive: true, force: true, maxRetries: 5 }) })
  const base = `http://127.0.0.1:${studio.port}`
  async function request(route, user = 'a', body, headers = {}) {
    return fetch(base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { cookie: user, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-node-idb-studio': '1' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  return { studio, request, grants }
}

test('Embed assets and API mount below a prefix, require host auth, and emit an exact frame policy', async t => {
  const { studio, request } = await fixture(t)
  assert.equal(studio.url, 'https://app.example.test/admin/studio/')
  assert.equal((await request('/admin/studio/', 'unknown')).status, 401)
  const page = await request('/admin/studio/')
  const html = await page.text()
  assert.match(html, /content="\/admin\/studio\/" name="studio-base-path"/)
  assert.match(html, /studio-embed embed-hide-header/)
  assert.match(html, /href="\.\/studio.css"/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/app.example.test;/)
  assert.equal(page.headers.get('x-frame-options'), null)
  assert.equal((await request('/admin/studio/studio.js')).status, 200)
  assert.equal((await request('/admin/studio/studio.css')).status, 200)
  assert.equal((await request('/api/state')).status, 404)
  const redirect = await request('/admin/studio')
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), '/admin/studio/')
  const badHost = await new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: studio.port, path: '/admin/studio/api/state', headers: { host: 'evil.example.test', cookie: 'a' } }, response => { response.resume(); resolve(response.statusCode) })
    outgoing.on('error', reject); outgoing.end()
  })
  assert.equal(badHost, 421)
})

test('Embed isolates concurrent users, refreshes and direct database APIs', async t => {
  const { request, grants } = await fixture(t)
  const states = await Promise.all(['a', 'b', 'a', 'b'].map(async user => (await request('/admin/studio/api/state', user)).json()))
  assert.deepEqual(states.map(state => state.databases.map(db => db.name)), [['alpha'], ['beta'], ['alpha'], ['beta']])
  assert.equal(states[0].rootPath, '')
  assert.equal(states[0].backupsEnabled, false)
  const beta = states[1].databases[0].id, alpha = states[0].databases[0].id
  assert.equal((await request(`/admin/studio/api/databases/${beta}/diagnostics`, 'a')).status, 404)
  assert.equal((await request('/admin/studio/api/query', 'a', { databaseId: beta, statement: 'SELECT * FROM items' })).status, 404)
  assert.equal((await request('/admin/studio/api/workspace/compare', 'a', { databaseId: alpha, collection: 'items', targetDatabaseId: beta, targetCollection: 'items', keyPath: 'owner' })).status, 404)
  const refreshes = await Promise.all(['a', 'b'].map(async user => (await request('/admin/studio/api/refresh', user, {})).json()))
  assert.deepEqual(refreshes.map(state => state.databases.map(db => db.name)), [['alpha'], ['beta']])
  grants.a = { subject: 'alice', databases: [], writable: false }
  assert.equal((await request('/admin/studio/api/query', 'a', { databaseId: alpha, statement: 'SELECT * FROM items' })).status, 404)
})

test('Embed enforces writes and CSRF protection, including ownership of import previews', async t => {
  const { request } = await fixture(t)
  const a = await (await request('/admin/studio/api/state', 'a')).json(), b = await (await request('/admin/studio/api/state', 'b')).json()
  const write = { databaseId: b.databases[0].id, collection: 'items', document: encodeStudioValue({ owner: 'new' }) }
  assert.equal((await request('/admin/studio/api/documents/insert', 'b', write)).status, 403)
  write.databaseId = a.databases[0].id
  assert.equal((await request('/admin/studio/api/documents/insert', 'a', write, { 'x-node-idb-studio': '' })).status, 403)
  assert.equal((await request('/admin/studio/api/documents/insert', 'a', write, { origin: 'https://evil.example.test' })).status, 403)
  assert.equal((await request('/admin/studio/api/documents/insert', 'a', write, { origin: 'https://app.example.test' })).status, 201)
  assert.equal((await request('/admin/studio/api/workspace/backups', 'a', {})).status, 403)
  const selected = { databaseId: a.databases[0].id, collection: 'items' }
  const preview = await (await request('/admin/studio/api/workspace/preview-import', 'a', { ...selected,
    bundle: { format: 'node-idb-transfer', version: 1, documents: [encodeStudioValue({ owner: 'imported' })] } })).json()
  const apply = { ...selected, ticket: preview.ticket, confirm: true }
  assert.equal((await request('/admin/studio/api/workspace/apply-import', 'c', apply)).status, 409)
  assert.equal((await request('/admin/studio/api/workspace/apply-import', 'a', apply)).status, 200)
})

test('Invalid embed configuration is rejected and local mode retains its original protection', async t => {
  for (const basePath of ['/missing-slash', '//', '/../', '/x%20/']) await assert.rejects(startStudio({ rootPath: '.', basePath }), /basePath/)
  await assert.rejects(startStudio({ rootPath: '.', embed: true }), /configuration/)
  await assert.rejects(startStudio({ rootPath: '.', embed: { publicOrigin: 'https://app.test', allowedParents: ['*'], authenticate: () => null } }), /URL|origin/)
  const { studio, request } = await fixture(t, { embed: false })
  const page = await request('/admin/studio/')
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const token = new URLSearchParams(new URL(studio.url).hash.slice(1)).get('token')
  assert.equal((await request('/admin/studio/api/state')).status, 401)
  assert.equal((await request('/admin/studio/api/state', 'a', undefined, { authorization: `Bearer ${token}` })).status, 200)
})
