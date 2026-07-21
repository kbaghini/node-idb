import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb } from '../src/index.js'

function findNode(node, requestedPath) {
  if (node.path === requestedPath) return node
  for (const child of node.children) {
    const match = findNode(child, requestedPath)
    if (match) return match
  }
  return null
}

test('structure reports an immutable observed tree with types, coverage, and indexes', async (t) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-structure-'))
  const database = createIdb({
    storagePath,
    fieldIndexes: {
      default: 'none',
      rules: [
        { collection: 'persons', path: 'contact.details.email', enabled: true },
      ],
    },
  })
  t.after(async () => {
    await database.close().catch(() => {})
    await rm(storagePath, { recursive: true, force: true })
  })

  await database.execute('INSERT INTO persons', [
    {
      name: 'Ada',
      contact: {
        details: { email: 'ada@example.test', phone: '+1-001' },
        labels: ['engineer', 'mathematician'],
      },
      mixed: { source: 'import' },
      nullish: undefined,
    },
    {
      name: 'Grace',
      contact: {
        details: { email: 'grace@example.test' },
        labels: ['computer-science'],
      },
      mixed: 'legacy',
      nullish: null,
    },
    {
      name: 'Linus',
      contact: null,
      mixed: 42,
    },
  ])

  const structure = await database.structure('PERSONS')
  assert.equal(structure.collection, 'persons')
  assert.equal(structure.path, null)
  assert.equal(structure.documentCount, 3)
  assert.equal(structure.fieldCount, 9)
  assert.equal(structure.maxDepth, 3)
  assert.equal(structure.root.path, '')
  assert.deepEqual(structure.root.types, [{ type: 'object', count: 3 }])

  const contact = findNode(structure.root, 'contact')
  assert.deepEqual(contact.types, [
    { type: 'object', count: 2 },
    { type: 'null', count: 1 },
  ])
  assert.equal(contact.coverage, 1)
  assert.equal(contact.coverageWithinParent, 1)
  assert.equal(contact.optional, false)
  assert.equal(contact.optionalWithinParent, false)

  const email = findNode(structure.root, 'contact.details.email')
  assert.deepEqual(email.types, [{ type: 'string', count: 2 }])
  assert.equal(email.presentInDocuments, 2)
  assert.equal(email.coverage, 2 / 3)
  assert.equal(email.optional, true)
  assert.equal(email.coverageWithinParent, 1)
  assert.equal(email.optionalWithinParent, false)
  assert.equal(email.indexed, true)

  const phone = findNode(structure.root, 'contact.details.phone')
  assert.equal(phone.coverage, 1 / 3)
  assert.equal(phone.coverageWithinParent, 0.5)
  assert.equal(phone.optionalWithinParent, true)
  assert.equal(phone.indexed, false)

  assert.deepEqual(findNode(structure.root, 'contact.labels').types, [
    { type: 'array', count: 2 },
  ])
  assert.deepEqual(findNode(structure.root, 'mixed').types, [
    { type: 'object', count: 1 },
    { type: 'string', count: 1 },
    { type: 'number', count: 1 },
  ])
  assert.deepEqual(findNode(structure.root, 'nullish').types, [
    { type: 'null', count: 2 },
  ])

  assert.equal(Object.isFrozen(structure), true)
  assert.equal(Object.isFrozen(structure.root), true)
  assert.equal(Object.isFrozen(structure.root.children), true)
  assert.equal(Object.isFrozen(email.types), true)
  assert.equal(Object.isFrozen(email.types[0]), true)
})

test('structure can focus an exact sub-field and validates requests without creating collections', async (t) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-substructure-'))
  const database = createIdb({ storagePath })
  t.after(async () => {
    await database.close().catch(() => {})
    await rm(storagePath, { recursive: true, force: true })
  })

  await database.execute('INSERT INTO persons', {
    contact: { details: { email: 'person@example.test', phone: '+1-002' } },
    labels: [{ internal: 'arrays remain atomic' }],
  })

  const details = await database.structure('persons', { path: 'contact.details' })
  assert.equal(details.path, 'contact.details')
  assert.equal(details.documentCount, 1)
  assert.equal(details.fieldCount, 3)
  assert.equal(details.maxDepth, 3)
  assert.equal(details.root.name, 'details')
  assert.equal(details.root.path, 'contact.details')
  assert.deepEqual(details.root.children.map((field) => field.name), ['email', 'phone'])

  const email = await database.structure('persons', {
    path: 'contact.details.email',
    timeoutMs: 1_000,
  })
  assert.equal(email.fieldCount, 1)
  assert.equal(email.root.path, 'contact.details.email')
  assert.deepEqual(email.root.children, [])

  await assert.rejects(database.structure('persons', { path: 'labels.0' }), /does not contain/i)
  await assert.rejects(database.structure('persons', { path: 'missing' }), /does not contain/i)
  await assert.rejects(database.structure('persons', { path: '' }), /non-empty canonical/i)
  await assert.rejects(database.structure('persons', { path: 'contact..email' }), /dot-separated/i)
  await assert.rejects(database.structure('persons', { path: '__proto__' }), /unsafe/i)
  await assert.rejects(database.structure('persons', { unknown: true }), /unknown structure option/i)
  await assert.rejects(database.structure('missing'), /does not exist/i)

  const files = await readdir(storagePath)
  assert.equal(files.some((filename) => filename.toLowerCase().includes('missing')), false)

  const controller = new AbortController()
  controller.abort(new Error('stop structure inspection'))
  await assert.rejects(
    database.structure('persons', { signal: controller.signal }),
    /aborted/i,
  )
})

test('structure works through a read-only engine', async (t) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-readonly-structure-'))
  const writer = createIdb({ storagePath })
  await writer.execute('INSERT INTO records', { nested: { active: true } })
  await writer.close()

  const reader = createIdb({ storagePath, mode: 'readonly' })
  t.after(async () => {
    await reader.close().catch(() => {})
    await rm(storagePath, { recursive: true, force: true })
  })
  const structure = await reader.structure('records', { path: 'nested' })
  assert.equal(structure.root.path, 'nested')
  assert.deepEqual(structure.root.types, [{ type: 'object', count: 1 }])
  assert.deepEqual(structure.root.children[0].types, [{ type: 'boolean', count: 1 }])
})
