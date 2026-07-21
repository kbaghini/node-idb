import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('one package publishes both the core API and Studio', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  )

  assert.equal(manifest.name, 'node-idb')
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.bin['node-idb'], 'bin/node-idb.js')
  assert.equal(manifest.exports['.'].import, './src/index.js')
  assert.equal(manifest.exports['./studio'].import, './src/studio/index.js')
  assert.ok(manifest.files.includes('src'))
  assert.ok(manifest.files.includes('docs'))

  await Promise.all([
    access(path.join(packageRoot, 'src', 'index.js')),
    access(path.join(packageRoot, 'src', 'studio', 'index.js')),
    access(path.join(packageRoot, 'src', 'studio', 'public', 'index.html')),
    access(path.join(packageRoot, 'src', 'studio', 'public', 'studio.js')),
    access(path.join(packageRoot, 'src', 'studio', 'public', 'studio.css')),
  ])
})
