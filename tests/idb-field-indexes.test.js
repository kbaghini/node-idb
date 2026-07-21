import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deserializeFieldIndexes,
  normalizeFieldIndexes,
} from '../src/idb/field-indexes.js'

test('field index policy defaults to a deeply frozen balanced automatic snapshot', () => {
  const policy = normalizeFieldIndexes()

  assert.equal(policy.mode, 'auto')
  assert.equal(policy.default, 'none')
  assert.equal(policy.auto.preset, 'balanced')
  assert.equal(policy.decision('users', 'email'), 'auto')
  assert.equal(policy.isIndexed('users', ''), false)
  assert.equal(policy.isIndexed('users', 'email'), false)
  assert.equal(JSON.parse(policy.serialized).version, 2)
  assert.equal(Object.isFrozen(policy), true)
  assert.equal(Object.isFrozen(policy.rules), true)

  const none = normalizeFieldIndexes('none')
  assert.equal(none.isIndexed('users', ''), false)
  assert.equal(none.isIndexed('users', 'email'), false)
  assert.equal(normalizeFieldIndexes('all').isIndexed('users', 'email'), true)
})

test('field index rules use exact collection identity, literal paths, and last-match wins', () => {
  const policy = normalizeFieldIndexes({
    default: 'none',
    rules: [
      { collection: '*', path: 'tenantId', enabled: true },
      { collection: 'Users', path: 'email', enabled: true },
      { collection: 'users', path: 'email', enabled: false },
      { collection: 'users', path: 'Email', enabled: true },
      { collection: 'users', path: '*', enabled: true },
    ],
  })

  assert.equal(policy.isIndexed('USERS', 'tenantId'), true)
  assert.equal(policy.isIndexed('orders', 'tenantId'), true)
  assert.equal(policy.isIndexed('users', 'email'), false)
  assert.equal(policy.isIndexed('users', 'Email'), true)
  assert.equal(policy.isIndexed('users', '*'), true)
  assert.equal(policy.isIndexed('users', 'name'), false)
  assert.equal(policy.isIndexed('users', ''), false)
  assert.equal(policy.rules[1].collection, 'users')
})

test('field index patterns use deterministic dot-segment glob semantics', () => {
  const policy = normalizeFieldIndexes({
    default: 'none',
    rules: [
      { collection: 'users', pattern: 'profile.*', enabled: true },
      { collection: 'users', pattern: 'audit.**', enabled: true },
      { collection: 'users', pattern: '**.id', enabled: true },
      { collection: 'users', pattern: 'literal*name', enabled: true },
      { collection: 'users', pattern: 'audit.private.**', enabled: false },
    ],
  })

  assert.equal(policy.isIndexed('users', 'profile.name'), true)
  assert.equal(policy.isIndexed('users', 'profile.address.city'), false)
  assert.equal(policy.isIndexed('users', 'profile'), false)
  assert.equal(policy.isIndexed('users', 'audit'), true)
  assert.equal(policy.isIndexed('users', 'audit.actor.id'), true)
  assert.equal(policy.isIndexed('users', 'record.id'), true)
  assert.equal(policy.isIndexed('users', 'id'), true)
  assert.equal(policy.isIndexed('users', 'literal*name'), true)
  assert.equal(policy.isIndexed('users', 'literalZZname'), false)
  assert.equal(policy.isIndexed('users', 'audit.private'), false)
  assert.equal(policy.isIndexed('users', 'audit.private.token'), false)
  assert.equal(policy.isIndexed('orders', 'audit.actor.id'), false)
})

test('normalization snapshots caller-owned input and serializes it canonically', () => {
  const rule = { collection: 'Users', path: 'email', enabled: true }
  const input = { default: 'none', rules: [rule] }
  const policy = normalizeFieldIndexes(input)
  const serialized = policy.serialized

  rule.collection = 'orders'
  rule.path = 'number'
  rule.enabled = false
  input.default = 'all'
  input.rules.push({ collection: '*', pattern: '**', enabled: false })

  assert.equal(policy.serialized, serialized)
  assert.equal(policy.isIndexed('users', 'email'), true)
  assert.equal(policy.isIndexed('orders', 'number'), false)
  assert.equal(Object.isFrozen(policy.rules[0]), true)

  const same = normalizeFieldIndexes({
    default: 'none',
    rules: [{ collection: 'users', path: 'email', enabled: true }],
  })
  assert.equal(same.serialized, serialized)
})

test('serialized policies round-trip and reject unsupported or malformed state', () => {
  const original = normalizeFieldIndexes({
    default: 'all',
    rules: [
      { collection: 'events', pattern: 'payload.**', enabled: false },
      { collection: 'events', path: 'payload.kind', enabled: true },
    ],
  })
  const restored = deserializeFieldIndexes(original.serialized)

  assert.equal(restored.serialized, original.serialized)
  assert.equal(restored.isIndexed('events', 'payload.value'), false)
  assert.equal(restored.isIndexed('events', 'payload.kind'), true)
  assert.equal(restored.isIndexed('users', 'email'), true)

  assert.throws(() => deserializeFieldIndexes(''), /non-empty string/i)
  assert.throws(() => deserializeFieldIndexes('{'), /valid JSON/i)
  assert.throws(
    () => deserializeFieldIndexes('{"version":3,"default":"all","rules":[]}'),
    /unsupported.*version/i,
  )
  assert.throws(
    () => deserializeFieldIndexes('{"version":1,"default":"all","rules":[],"extra":true}'),
    /unknown.*extra/i,
  )
})

test('automatic policies round-trip, validate tuning, and keep rules authoritative', () => {
  const policy = normalizeFieldIndexes({
    mode: 'auto',
    preset: 'aggressive',
    minDocuments: 25,
    minQueryCount: 4,
    maxResultRatio: 0.4,
    allowDrop: true,
    rules: [
      { collection: 'users', path: 'email', enabled: true },
      { collection: 'users', pattern: 'payload.**', enabled: false },
    ],
  })
  const restored = deserializeFieldIndexes(policy.serialized)
  assert.equal(restored.serialized, policy.serialized)
  assert.equal(restored.decision('users', 'email'), 'enabled')
  assert.equal(restored.decision('users', 'payload.token'), 'disabled')
  assert.equal(restored.decision('users', 'name'), 'auto')
  assert.equal(restored.auto.minDocuments, 25)

  assert.throws(
    () => normalizeFieldIndexes({ mode: 'auto', maxResultRatio: 2 }),
    /maxResultRatio/i,
  )
  assert.throws(
    () => normalizeFieldIndexes({ mode: 'auto', allowDrop: 'yes' }),
    /allowDrop/i,
  )
})

test('field index policies reject ambiguous, mutable, and malformed contracts', () => {
  const invalid = [
    [null, /must be.*policy object/i],
    [[], /must be.*policy object/i],
    ['sometimes', /must be.*policy object/i],
    [{ default: true }, /default.*all.*none/i],
    [{ rules: {} }, /rules.*array/i],
    [{ extra: true }, /unknown.*extra/i],
    [{ rules: [null] }, /rules\[0\].*object/i],
    [{ rules: [{}] }, /exactly one.*path.*pattern/i],
    [{ rules: [{ collection: 'users', path: 'email', pattern: '**', enabled: true }] }, /exactly one/i],
    [{ rules: [{ collection: 'users', path: 'email' }] }, /enabled.*boolean/i],
    [{ rules: [{ collection: 'bad name', path: 'email', enabled: true }] }, /collection.*only letters/i],
    [{ rules: [{ collection: 'users', path: '', enabled: true }] }, /path.*non-empty/i],
    [{ rules: [{ collection: 'users', path: 'profile..name', enabled: true }] }, /empty path segments/i],
    [{ rules: [{ collection: 'users', pattern: 'profile.', enabled: true }] }, /empty path segments/i],
    [{ rules: [{ collection: 'users', path: 'email', enabled: true, extra: 1 }] }, /unknown.*extra/i],
  ]

  for (const [value, expected] of invalid) {
    assert.throws(() => normalizeFieldIndexes(value), expected)
  }
  assert.throws(() => normalizeFieldIndexes().isIndexed('*', 'email'), /concrete collection/i)
  assert.throws(() => normalizeFieldIndexes().isIndexed('users', /** @type {any} */ (null)), /field path/i)
})
