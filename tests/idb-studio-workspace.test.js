import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readdir, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createIdb } from '../src/index.js'
import { startStudio, encodeStudioValue, decodeStudioValue } from '../src/studio/index.js'
import { compareDocuments } from '../src/studio/workspace.js'

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'node-idb-workspace-test-'))
  const rootPath = path.join(temporary, 'data'), backupPath = path.join(temporary, 'backups')
  await mkdir(rootPath)
  const engine = createIdb({ storagePath: path.join(rootPath, 'app') })
  await engine.execute('INSERT INTO source', [{ key: 'a', date: new Date('2026-01-01'), integer: 123n, bytes: Buffer.from('hello') }, { key: 'b', value: 2 }])
  await engine.execute('INSERT INTO target', [{ key: 'b', value: 3 }, { key: 'c', value: 4 }])
  await engine.close()
  const studio = await startStudio({ rootPath, backupPath, port: 0, writable: true, ...options })
  t.after(async () => { await studio.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5 }) })
  const location = new URL(studio.url), token = new URLSearchParams(location.hash.slice(1)).get('token')
  async function request(action, body, authenticated = true) {
    const response = await fetch(`${location.origin}/api/workspace/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const state = await studio.refresh(), databaseId = state.databases.find(item => item.name === 'app').id
  return { request, studio, databaseId, backupPath, rootPath }
}

test('Workspace exports native types and applies a reviewed batch only once', async t => {
  const { request, databaseId } = await fixture(t)
  const selected = { databaseId, collection: 'source' }
  assert.equal((await request('export', selected, false)).status, 401)
  const exported = await request('export', selected)
  assert.equal(exported.status, 200)
  const document = decodeStudioValue(exported.body.documents[0])
  assert.equal(document.integer, 123n)
  assert.ok(document.date instanceof Date)
  assert.deepEqual(document.bytes, Buffer.from('hello'))
  const destination = { databaseId, collection: 'target' }
  const preview = await request('preview-import', { ...destination, bundle: exported.body })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.count, 2)
  assert.equal((await request('apply-import', { ...selected, ticket: preview.body.ticket, confirm: true })).status, 409)
  const apply = { ...destination, ticket: preview.body.ticket, confirm: true }
  const results = await Promise.all([request('apply-import', apply), request('apply-import', apply)])
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409])
  assert.equal((await request('export', destination)).body.documents.length, 4)
})

test('Workspace import rolls back the entire batch when a later document is invalid', async t => {
  const { request, databaseId } = await fixture(t)
  const selected = { databaseId, collection: 'target' }
  const bundle = { format: 'node-idb-transfer', version: 1, documents: [encodeStudioValue({ key: 'valid' }), encodeStudioValue({ 'invalid.key': 1 })] }
  const preview = await request('preview-import', { ...selected, bundle })
  const applied = await request('apply-import', { ...selected, ticket: preview.body.ticket, confirm: true })
  assert.notEqual(applied.status, 200)
  assert.equal((await request('export', selected)).body.documents.length, 2)
})

test('Workspace comparisons detect changes, preserve types, ignore object key order and reject ambiguous keys', async t => {
  const { request, databaseId } = await fixture(t)
  const comparison = await request('compare', { databaseId, collection: 'source', targetDatabaseId: databaseId, targetCollection: 'target', keyPath: 'key' })
  assert.equal(comparison.status, 200)
  assert.deepEqual(comparison.body.counts, { added: 1, removed: 1, changed: 1, unchanged: 0 })
  assert.equal(compareDocuments([{ id: 1, a: 2 }], [{ a: 2, id: 1 }], 'id').counts.unchanged, 1)
  assert.equal(compareDocuments([{ id: 1, a: 2n }], [{ id: 1, a: 2 }], 'id').counts.changed, 1)
  assert.throws(() => compareDocuments([{ id: 1 }, { id: 1 }], [], 'id'), /unique/)
  assert.throws(() => compareDocuments([{}], [], 'id'), /scalar/)
})

test('Workspace caps complete exports instead of silently truncating them and denies readonly writes', async t => {
  const { request, databaseId } = await fixture(t, { writable: false, maxTransferRows: 1 })
  const selected = { databaseId, collection: 'source' }
  assert.equal((await request('export', selected)).status, 413)
  assert.equal((await request('apply-import', { ...selected, confirm: true })).status, 403)
  assert.equal((await request('restore-backup', { id: '../outside', confirm: true })).status, 403)
  assert.equal((await request('preview-import', { ...selected, bundle: { format: 'wrong' } })).status, 400)
})

test('Managed backups verify integrity and restore to a separate discoverable database', async t => {
  const { request, studio, databaseId, backupPath, rootPath } = await fixture(t)
  const backup = await request('backup', { databaseId })
  assert.equal(backup.status, 200)
  assert.ok((await request('backups', {})).body.backups.some(item => item.id === backup.body.id))
  const verified = await request('verify-backup', { id: backup.body.id })
  assert.equal(verified.body.verified, true)
  assert.equal((await request('verify-backup', { id: '../data' })).status, 400)
  assert.equal((await request('restore-backup', { id: backup.body.id })).status, 400)
  const restored = await request('restore-backup', { id: backup.body.id, confirm: true })
  assert.equal(restored.status, 200)
  assert.ok((await studio.refresh()).databases.some(item => item.name === restored.body.database))
  assert.ok((await readdir(rootPath)).includes('app'))
  const files = await readdir(path.join(backupPath, backup.body.id))
  const sqlite = files.find(file => file.endsWith('.sqlite'))
  await writeFile(path.join(backupPath, backup.body.id, sqlite), 'damaged')
  assert.notEqual((await request('verify-backup', { id: backup.body.id })).status, 200)
})

test('Backup folder links cannot bypass root isolation on repeated attempts', async t => {
  const { request, backupPath, rootPath } = await fixture(t)
  await symlink(rootPath, backupPath, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await request('backups', {})).status, 400)
  assert.equal((await request('backups', {})).status, 400)
})

test('Readonly Studio can create configured snapshots but backup management is opt-in', async t => {
  const readonly = await fixture(t, { writable: false })
  assert.equal((await readonly.request('backup', { databaseId: readonly.databaseId })).status, 200)
  const disabled = await fixture(t, { backupPath: undefined })
  assert.equal((await disabled.request('backups', {})).status, 403)
})
