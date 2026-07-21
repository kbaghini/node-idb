import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb } from '../src/index.js'
import {
  decodeStudioValue,
  encodeStudioValue,
} from '../src/studio/codec.js'
import { startStudio } from '../src/studio/index.js'

const bearerPattern = /^Bearer\s+/i

function encodeWire(value, seen = new WeakSet(), depth = 0) {
  if (depth > 128) throw new RangeError('Wire test value is too deeply nested')
  if (value === null) return ['null']
  if (value === undefined) return ['undefined']
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'bigint') return ['bigint', value.toString()]
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    return ['number', value]
  }
  if (value instanceof Date) return ['date', value.toISOString()]
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return ['binary', bytes.toString('base64')]
  }
  if (value instanceof ArrayBuffer) {
    return ['binary', Buffer.from(value).toString('base64')]
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError(`Unsupported wire value: ${typeof value}`)
  }
  if (seen.has(value)) throw new TypeError('Wire values cannot be circular')

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return ['array', value.map((entry) => encodeWire(entry, seen, depth + 1))]
    }
    return [
      'object',
      Object.entries(value).map(([key, entry]) => [
        key,
        encodeWire(entry, seen, depth + 1),
      ]),
    ]
  } finally {
    seen.delete(value)
  }
}

function decodeWire(node, depth = 0) {
  if (depth > 128) throw new RangeError('Wire response is too deeply nested')
  assert.ok(Array.isArray(node), 'a Studio wire value must be a tagged array')
  const [tag, payload] = node
  switch (tag) {
    case 'null':
      return null
    case 'undefined':
      return undefined
    case 'boolean':
    case 'string':
      return payload
    case 'number':
      if (payload === 'NaN') return Number.NaN
      if (payload === 'Infinity') return Infinity
      if (payload === '-Infinity') return -Infinity
      return payload
    case 'bigint':
      return BigInt(payload)
    case 'date':
      return new Date(payload)
    case 'binary':
      return Buffer.from(payload, 'base64')
    case 'array':
      return payload.map((entry) => decodeWire(entry, depth + 1))
    case 'object': {
      const value = {}
      for (const [key, entry] of payload) {
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: decodeWire(entry, depth + 1),
        })
      }
      return value
    }
    default:
      assert.fail(`Unknown Studio wire tag: ${String(tag)}`)
  }
}

function studioLocation(studio) {
  const url = new URL(studio.url)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const token = fragment.get('token') || studio.token
  assert.ok(token, 'Studio URL must carry its launch token in the fragment')
  url.hash = ''
  url.search = ''
  url.pathname = '/'
  return { origin: url.origin, token }
}

async function request(studio, route, options = {}) {
  const { origin, token } = studioLocation(studio)
  const {
    authenticated = true,
    body,
    headers: customHeaders = {},
    method = body === undefined ? 'GET' : 'POST',
  } = options
  const headers = new Headers(customHeaders)
  if (authenticated && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(new URL(route, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function jsonResponse(response) {
  const text = await response.text()
  assert.notEqual(text, '', `expected JSON from ${response.url}`)
  return JSON.parse(text)
}

function rawRequest(studio, route, headers = {}) {
  const { token } = studioLocation(studio)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: studio.host,
        port: studio.port,
        path: route,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...headers,
        },
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function collectionName(collection) {
  return typeof collection === 'string'
    ? collection
    : collection.name || collection.collection
}

function collectionsOf(database) {
  return (database.collections || []).map(collectionName)
}

function databaseWithCollection(state, collection) {
  const database = state.databases.find((candidate) =>
    collectionsOf(candidate).includes(collection),
  )
  assert.ok(database, `expected a discovered database containing ${collection}`)
  assert.equal(typeof database.id, 'string')
  assert.notEqual(database.id, '')
  return database
}

async function writeDocuments(storagePath, collection, documents) {
  const database = createIdb({ storagePath })
  try {
    await database.execute(`INSERT INTO ${collection}`, documents)
  } finally {
    await database.close()
  }
}

async function readDocuments(storagePath, collection) {
  const database = createIdb({ storagePath })
  try {
    return await database.execute(
      `SELECT * FROM ${collection} ORDER BY object_id`,
    )
  } finally {
    await database.close()
  }
}

async function createFixture(t, prefix) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), prefix))
  const studios = []
  t.after(async () => {
    for (const studio of studios.reverse()) await studio.close().catch(() => {})
    await rm(rootPath, { recursive: true, force: true })
  })
  return {
    rootPath,
    async start(options = {}) {
      const studio = await startStudio({ rootPath, port: 0, ...options })
      studios.push(studio)
      return studio
    },
  }
}

test('Studio wire codec preserves every supported transport type without reserved-key collisions', () => {
  const value = {
    nullValue: null,
    undefinedValue: undefined,
    trueValue: true,
    finite: 1.25,
    notANumber: Number.NaN,
    positiveInfinity: Infinity,
    negativeInfinity: -Infinity,
    text: 'typed',
    bigint: 9_007_199_254_740_993n,
    date: new Date('2026-07-21T08:30:00.000Z'),
    bytes: Buffer.from([0, 1, 127, 128, 255]),
    nested: [undefined, { __ev3_idb_type__: 'ordinary user data' }],
  }
  Object.defineProperty(value, '__proto__', {
    enumerable: true,
    value: { safe: true },
  })

  const wire = encodeStudioValue(value)
  assert.deepEqual(wire, encodeWire(value))
  const decoded = decodeStudioValue(wire)
  assert.equal(decoded.nullValue, null)
  assert.equal(decoded.undefinedValue, undefined)
  assert.equal(Object.hasOwn(decoded, 'undefinedValue'), true)
  assert.equal(Number.isNaN(decoded.notANumber), true)
  assert.equal(decoded.positiveInfinity, Infinity)
  assert.equal(decoded.negativeInfinity, -Infinity)
  assert.equal(decoded.bigint, value.bigint)
  assert.deepEqual(decoded.date, value.date)
  assert.deepEqual(decoded.bytes, value.bytes)
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype)
  assert.equal(Object.hasOwn(decoded, '__proto__'), true)
  assert.deepEqual(decoded.__proto__, { safe: true })
  assert.deepEqual(decodeWire(wire), decoded)

  assert.throws(
    () => decodeStudioValue(['object', [['duplicate', ['null']], ['duplicate', ['null']]]]),
    /duplicate/i,
  )
  assert.throws(() => decodeStudioValue(['binary', 'not base64']), /base64/i)
  assert.throws(
    () => encodeStudioValue('too long', { maxStringBytes: 2 }),
    /cannot exceed/i,
  )
})

test('startStudio validates configuration before listening', async () => {
  const invalid = [
    [undefined, /options object/i],
    [{}, /rootPath.*non-empty string/i],
    [{ rootPath: '' }, /rootPath.*non-empty string/i],
    [{ rootPath: 'invalid\0path' }, /null bytes/i],
    [{ rootPath: '.', port: -1 }, /port.*integer/i],
    [{ rootPath: '.', port: 65_536 }, /port.*integer/i],
    [{ rootPath: '.', writable: 'yes' }, /writable.*boolean/i],
    [{ rootPath: '.', maxRows: 0 }, /maxRows.*integer.*1/i],
    [{ rootPath: '.', queryTimeoutMs: 0 }, /queryTimeoutMs.*integer.*1/i],
    [{ rootPath: '.', bodyLimitBytes: 0 }, /bodyLimitBytes.*integer.*1/i],
    [{ rootPath: '.', host: '0.0.0.0' }, /unknown.*host/i],
  ]

  for (const [options, expected] of invalid) {
    await assert.rejects(
      Promise.resolve().then(() => startStudio(options)),
      expected,
    )
  }
})

test('Studio is loopback-only, token-protected, origin-bound, and closes cleanly', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-security-')
  const studio = await fixture.start({ bodyLimitBytes: 1_024 })
  const { origin, token } = studioLocation(studio)

  assert.equal(studio.host, '127.0.0.1')
  assert.equal(new URL(studio.url).hostname, '127.0.0.1')
  assert.equal(studio.port > 0, true)
  assert.equal(studio.closed, false)
  assert.equal(studio.rootPath, await realpath(fixture.rootPath))
  assert.equal(new URL(studio.url).search, '')
  assert.equal(bearerPattern.test(token), false)

  const shell = await request(studio, '/', { authenticated: false })
  assert.equal(shell.status, 200)
  assert.match(shell.headers.get('content-type'), /text\/html/i)
  assert.match(shell.headers.get('cache-control'), /no-store/i)
  assert.match(shell.headers.get('content-security-policy'), /default-src 'self'/i)
  assert.equal(shell.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer')
  assert.doesNotMatch(await shell.text(), new RegExp(token, 'g'))

  const missingToken = await request(studio, '/api/state', {
    authenticated: false,
  })
  assert.equal(missingToken.status, 401)
  assert.equal((await jsonResponse(missingToken)).error.code, 'unauthorized')

  const wrongToken = await request(studio, '/api/state', {
    headers: { authorization: `Bearer ${'x'.repeat(token.length)}` },
  })
  assert.equal(wrongToken.status, 401)

  const wrongOrigin = await request(studio, '/api/state', {
    headers: { origin: 'https://attacker.example' },
  })
  assert.equal(wrongOrigin.status, 403)

  const allowedOrigin = await request(studio, '/api/state', {
    headers: { origin },
  })
  assert.equal(allowedOrigin.status, 200)

  const wrongHostStatus = await rawRequest(studio, '/api/state', {
    host: `attacker.example:${studio.port}`,
  })
  assert.equal(wrongHostStatus, 421)

  const oversized = await request(studio, '/api/query', {
    body: { padding: 'x'.repeat(2_000) },
  })
  assert.equal(oversized.status, 413)
  assert.equal((await jsonResponse(oversized)).error.code, 'body_too_large')

  await studio.close()
  assert.equal(studio.closed, true)
  await studio.close()
  assert.equal(studio.closed, true)
  await assert.rejects(fetch(`${origin}/api/state`), /fetch failed|connect|closed/i)
})

test('discovery includes the root and immediate databases but not grandchildren or escaping links', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-discovery-')
  const childPath = path.join(fixture.rootPath, 'development')
  const grandchildPath = path.join(fixture.rootPath, 'nested', 'ignored')
  const outsidePath = await mkdtemp(path.join(os.tmpdir(), 'node-idb-studio-outside-'))
  t.after(() => rm(outsidePath, { recursive: true, force: true }))

  await writeDocuments(fixture.rootPath, 'root_records', [{ source: 'root' }])
  await writeDocuments(childPath, 'users', [{ source: 'child' }])
  await writeDocuments(grandchildPath, 'secret_records', [{ source: 'grandchild' }])
  await writeDocuments(outsidePath, 'outside_records', [{ source: 'outside' }])
  await mkdir(path.join(fixture.rootPath, 'unrelated'))

  let symlinkCreated = true
  try {
    await symlink(
      outsidePath,
      path.join(fixture.rootPath, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    symlinkCreated = false
  }

  const studio = await fixture.start()
  const response = await request(studio, '/api/state')
  assert.equal(response.status, 200)
  const state = await jsonResponse(response)

  assert.equal(state.writable, false)
  assert.equal(Array.isArray(state.databases), true)
  assert.equal(state.databases.length, 2)
  databaseWithCollection(state, 'root_records')
  databaseWithCollection(state, 'users')
  assert.equal(
    state.databases.some((database) =>
      collectionsOf(database).includes('secret_records'),
    ),
    false,
  )
  if (symlinkCreated) {
    assert.equal(
      state.databases.some((database) =>
        collectionsOf(database).includes('outside_records'),
      ),
      false,
    )
  }
  for (const database of state.databases) {
    assert.equal(path.isAbsolute(database.id), false)
    assert.equal(database.id.includes('..'), false)
  }

  const rawPathRequest = await request(studio, '/api/documents/list', {
    body: {
      databaseId: childPath,
      collection: 'users',
      limit: 10,
      offset: 0,
      order: 'asc',
    },
  })
  assert.equal(rawPathRequest.status, 404)

  const childDatabase = databaseWithCollection(state, 'users')
  const unlistedCollection = await request(studio, '/api/documents/list', {
    body: {
      databaseId: childDatabase.id,
      collection: '../outside_records',
      limit: 10,
      offset: 0,
      order: 'asc',
    },
  })
  assert.equal([400, 404].includes(unlistedCollection.status), true)
})

test('writable Studio refuses to recreate cataloged files removed after discovery', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-stale-catalog-')
  await writeDocuments(fixture.rootPath, 'people', [{ name: 'Existing' }])
  const studio = await fixture.start({ writable: true })
  const state = await jsonResponse(await request(studio, '/api/state'))
  const database = databaseWithCollection(state, 'people')
  const collectionPath = path.join(fixture.rootPath, 'db-collection-people.sqlite')
  const blobPath = path.join(fixture.rootPath, 'db-blobs-people.sqlite')

  await rm(collectionPath)
  await rm(blobPath)
  const response = await request(studio, '/api/documents/insert', {
    body: {
      databaseId: database.id,
      collection: 'people',
      document: encodeWire({ name: 'Must not be recreated' }),
    },
  })

  assert.equal(response.status, 409)
  assert.equal((await jsonResponse(response)).error.code, 'database_stale')
  await assert.rejects(access(collectionPath))
  await assert.rejects(access(blobPath))
})

test('read-only Studio browses schema and diagnostics but denies every mutation', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-readonly-')
  await writeDocuments(fixture.rootPath, 'people', [
    {
      name: 'Ada',
      profile: { active: true, tags: ['engineer', 'mathematician'] },
      score: 10,
      optionalNote: 'first',
      mixed: 'text',
    },
    {
      name: 'Grace',
      profile: { active: false, tags: ['computer-science'] },
      score: 20,
      mixed: 42,
    },
  ])
  const studio = await fixture.start()
  const state = await jsonResponse(await request(studio, '/api/state'))
  const database = databaseWithCollection(state, 'people')

  const listedResponse = await request(studio, '/api/documents/list', {
    body: {
      databaseId: database.id,
      collection: 'people',
      limit: 25,
      offset: 0,
      order: 'asc',
    },
  })
  assert.equal(listedResponse.status, 200)
  const listed = await jsonResponse(listedResponse)
  assert.equal(listed.total, 2)
  assert.equal(listed.documents.length, 2)
  assert.equal(Number.isInteger(listed.documents[0].objectId), true)
  assert.deepEqual(decodeWire(listed.documents[0].document), {
    name: 'Ada',
    profile: { active: true, tags: ['engineer', 'mathematician'] },
    score: 10,
    optionalNote: 'first',
    mixed: 'text',
  })

  const schemaResponse = await request(
    studio,
    `/api/databases/${encodeURIComponent(database.id)}/collections/people/schema`,
  )
  assert.equal(schemaResponse.status, 200)
  const schema = await jsonResponse(schemaResponse)
  assert.equal(schema.documentCount, 2)
  assert.equal(schema.fields.find((field) => field.parentFieldId === null).path, '')
  assert.deepEqual(
    schema.fields.find((field) => field.path === 'name').types,
    [{ type: 'string', count: 2 }],
  )
  assert.deepEqual(
    schema.fields.find((field) => field.path === 'profile').types,
    [{ type: 'object', count: 2 }],
  )
  assert.deepEqual(
    schema.fields.find((field) => field.path === 'profile.tags').types,
    [{ type: 'array', count: 2 }],
  )
  assert.deepEqual(
    schema.fields.find((field) => field.path === 'mixed').types,
    [{ type: 'string', count: 1 }, { type: 'number', count: 1 }],
  )
  const optionalField = schema.fields.find((field) => field.path === 'optionalNote')
  assert.equal(optionalField.presentInDocuments, 1)
  assert.equal(optionalField.coverage, 0.5)
  assert.equal(optionalField.optional, true)
  assert.equal(optionalField.coverageWithinParent, 0.5)
  assert.equal(optionalField.optionalWithinParent, true)
  assert.equal(typeof optionalField.indexed, 'boolean')

  const summaryResponse = await request(
    studio,
    `/api/databases/${encodeURIComponent(database.id)}/collections/people/schema?summary=1`,
  )
  assert.equal(summaryResponse.status, 200)
  const summary = await jsonResponse(summaryResponse)
  assert.equal(summary.statisticsIncluded, false)
  assert.equal(summary.fields.find((field) => field.path === 'profile.tags').types, null)
  assert.equal(summary.fields.find((field) => field.path === 'profile.tags').coverage, null)

  const diagnosticsResponse = await request(
    studio,
    `/api/databases/${encodeURIComponent(database.id)}/diagnostics`,
  )
  assert.equal(diagnosticsResponse.status, 200)
  assert.equal(typeof (await jsonResponse(diagnosticsResponse)), 'object')

  const writeRequests = [
    [
      '/api/documents/insert',
      {
        databaseId: database.id,
        collection: 'people',
        document: encodeWire({ name: 'Grace' }),
      },
    ],
    [
      '/api/documents/update',
      {
        databaseId: database.id,
        collection: 'people',
        objectId: listed.documents[0].objectId,
        document: encodeWire({ active: false }),
      },
    ],
    [
      '/api/documents/replace',
      {
        databaseId: database.id,
        collection: 'people',
        objectId: listed.documents[0].objectId,
        document: encodeWire({ name: 'Replacement' }),
      },
    ],
    [
      '/api/documents/delete',
      {
        databaseId: database.id,
        collection: 'people',
        objectId: listed.documents[0].objectId,
        confirm: true,
      },
    ],
    [`/api/databases/${encodeURIComponent(database.id)}/analyze`, {}],
    [`/api/databases/${encodeURIComponent(database.id)}/optimize-indexes`, {}],
  ]

  for (const [route, body] of writeRequests) {
    const response = await request(studio, route, { body })
    assert.equal(response.status, 403, `${route} must be denied in read-only mode`)
    assert.equal((await jsonResponse(response)).error.code, 'studio_read_only')
  }

  await studio.close()
  assert.deepEqual(await readDocuments(fixture.rootPath, 'people'), [
    {
      name: 'Ada',
      profile: { active: true, tags: ['engineer', 'mathematician'] },
      score: 10,
      optionalNote: 'first',
      mixed: 'text',
    },
    {
      name: 'Grace',
      profile: { active: false, tags: ['computer-science'] },
      score: 20,
      mixed: 42,
    },
  ])
})

test('writable Studio performs typed insert, update, replace, and confirmed delete', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-crud-')
  await writeDocuments(fixture.rootPath, 'people', [{ name: 'Seed' }])
  const studio = await fixture.start({ writable: true })
  const state = await jsonResponse(await request(studio, '/api/state'))
  assert.equal(state.writable, true)
  const database = databaseWithCollection(state, 'people')
  const missingReplace = await request(studio, '/api/documents/replace', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: 9_999_999,
      document: encodeWire({ name: 'Must not be inserted' }),
    },
  })
  assert.equal(missingReplace.status, 404)
  assert.equal((await jsonResponse(missingReplace)).error.code, 'document_not_found')
  const typed = {
    name: 'Typed',
    count: 9_007_199_254_740_993n,
    createdAt: new Date('2026-07-21T08:30:00.000Z'),
    bytes: Buffer.from([0, 1, 127, 128, 255]),
    nested: { enabled: true },
    values: [1, undefined, 7n, { deep: ['value'] }],
  }

  const insertedResponse = await request(studio, '/api/documents/insert', {
    body: {
      databaseId: database.id,
      collection: 'people',
      document: encodeWire(typed),
    },
  })
  assert.equal(insertedResponse.status, 201)
  const inserted = await jsonResponse(insertedResponse)
  assert.equal(Number.isInteger(inserted.objectId), true)

  const rootArray = [1, undefined, 7n, { nested: ['value'] }]
  const rootArrayInsert = await request(studio, '/api/documents/insert', {
    body: {
      databaseId: database.id,
      collection: 'people',
      document: encodeWire(rootArray),
    },
  })
  assert.equal(rootArrayInsert.status, 201)
  const rootArrayId = (await jsonResponse(rootArrayInsert)).objectId
  const rootArrayQuery = await jsonResponse(
    await request(studio, '/api/query', {
      body: {
        databaseId: database.id,
        statement: 'SELECT * FROM people WHERE object_id = $id',
        parameters: encodeWire({ $id: rootArrayId }),
      },
    }),
  )
  assert.deepEqual(decodeWire(rootArrayQuery.rows), [rootArray])

  const rootArrayReplace = await request(studio, '/api/documents/replace', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: rootArrayId,
      document: encodeWire(['replacement']),
    },
  })
  assert.equal(rootArrayReplace.status, 422)
  assert.equal(
    (await jsonResponse(rootArrayReplace)).error.code,
    'root_array_replace_unsupported',
  )

  const rootArrayUpdate = await request(studio, '/api/documents/update', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: rootArrayId,
      document: encodeWire(['update']),
    },
  })
  assert.equal(rootArrayUpdate.status, 400)
  assert.equal((await jsonResponse(rootArrayUpdate)).error.code, 'invalid_update')

  const rootArrayDelete = await request(studio, '/api/documents/delete', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: rootArrayId,
      confirm: true,
    },
  })
  assert.equal(rootArrayDelete.status, 200)

  const queried = await jsonResponse(
    await request(studio, '/api/query', {
      body: {
        databaseId: database.id,
        statement: 'SELECT * FROM people WHERE name = $name',
        parameters: encodeWire({ $name: 'Typed' }),
      },
    }),
  )
  assert.deepEqual(decodeWire(queried.rows), [typed])

  const updatedResponse = await request(studio, '/api/documents/update', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: inserted.objectId,
      document: encodeWire({ nested: { updated: true }, added: 'yes' }),
    },
  })
  assert.equal(updatedResponse.status, 200)
  assert.deepEqual(await jsonResponse(updatedResponse), {
    objectId: inserted.objectId,
    updated: true,
  })

  const afterUpdate = decodeWire(
    (
      await jsonResponse(
        await request(studio, '/api/query', {
          body: {
            databaseId: database.id,
            statement: 'SELECT * FROM people WHERE object_id = $id',
            parameters: encodeWire({ $id: inserted.objectId }),
          },
        }),
      )
    ).rows,
  )
  assert.equal(afterUpdate[0].name, 'Typed')
  assert.deepEqual(afterUpdate[0].nested, { enabled: true, updated: true })
  assert.equal(afterUpdate[0].added, 'yes')

  const replacement = { name: 'Replacement', tags: ['one', 'two'] }
  const replacedResponse = await request(studio, '/api/documents/replace', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: inserted.objectId,
      document: encodeWire(replacement),
    },
  })
  assert.equal(replacedResponse.status, 200)

  const afterReplace = decodeWire(
    (
      await jsonResponse(
        await request(studio, '/api/query', {
          body: {
            databaseId: database.id,
            statement: 'SELECT * FROM people WHERE object_id = $id',
            parameters: encodeWire({ $id: inserted.objectId }),
          },
        }),
      )
    ).rows,
  )
  assert.deepEqual(afterReplace, [replacement])

  const unconfirmed = await request(studio, '/api/documents/delete', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: inserted.objectId,
      confirm: false,
    },
  })
  assert.equal(unconfirmed.status, 400)

  const deletedResponse = await request(studio, '/api/documents/delete', {
    body: {
      databaseId: database.id,
      collection: 'people',
      objectId: inserted.objectId,
      confirm: true,
    },
  })
  assert.equal(deletedResponse.status, 200)
  assert.deepEqual(await jsonResponse(deletedResponse), {
    objectId: inserted.objectId,
    deleted: true,
  })

  const remaining = decodeWire(
    (
      await jsonResponse(
        await request(studio, '/api/query', {
          body: {
            databaseId: database.id,
            statement: 'SELECT * FROM people ORDER BY object_id',
            parameters: encodeWire([]),
          },
        }),
      )
    ).rows,
  )
  assert.deepEqual(remaining, [{ name: 'Seed' }])

  const nonFinite = await request(studio, '/api/documents/insert', {
    body: {
      databaseId: database.id,
      collection: 'people',
      document: encodeWire({ invalid: Number.NaN }),
    },
  })
  assert.equal(nonFinite.status, 422)
  assert.match((await jsonResponse(nonFinite)).error.message, /finite/i)
})

test('query endpoint accepts only canonical SELECT and enforces maxRows', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-query-')
  await writeDocuments(
    fixture.rootPath,
    'records',
    Array.from({ length: 6 }, (_, index) => ({
      sequence: index,
      label: index === 0 ? 'semi;colon' : `record-${index}`,
      details: { parity: index % 2 ? 'odd' : 'even' },
    })),
  )
  const studio = await fixture.start({ maxRows: 2, writable: true })
  const state = await jsonResponse(await request(studio, '/api/state'))
  assert.equal(state.limits.maxRows, 2)
  const database = databaseWithCollection(state, 'records')

  const response = await request(studio, '/api/query', {
    body: {
      databaseId: database.id,
      statement: 'SELECT item.* FROM "records" AS item ORDER BY item.object_id LIMIT 6',
      parameters: encodeWire([]),
    },
  })
  assert.equal(response.status, 200)
  const result = await jsonResponse(response)
  assert.equal(result.rowCount, 2)
  assert.equal(result.truncated, true)
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(decodeWire(result.rows).length, 2)

  const filesBeforeMissingQuery = (await readdir(fixture.rootPath)).sort()
  const missingCollection = await request(studio, '/api/query', {
    body: {
      databaseId: database.id,
      statement: 'SELECT COUNT(*) AS count FROM unknown_collection',
      parameters: encodeWire([]),
    },
  })
  assert.equal(missingCollection.status, 404)
  assert.equal(
    (await jsonResponse(missingCollection)).error.code,
    'collection_not_found',
  )
  assert.deepEqual((await readdir(fixture.rootPath)).sort(), filesBeforeMissingQuery)

  const quotedSemicolon = await request(studio, '/api/query', {
    body: {
      databaseId: database.id,
      statement: "SELECT * FROM records WHERE label = 'semi;colon'",
      parameters: encodeWire([]),
    },
  })
  assert.equal(quotedSemicolon.status, 200)
  assert.deepEqual(decodeWire((await jsonResponse(quotedSemicolon)).rows), [
    {
      sequence: 0,
      label: 'semi;colon',
      details: { parity: 'even' },
    },
  ])

  const optionalTerminator = await request(studio, '/api/query', {
    body: {
      databaseId: database.id,
      statement: 'SELECT * FROM records LIMIT 1;',
      parameters: encodeWire([]),
    },
  })
  assert.equal(optionalTerminator.status, 200)

  const parameterized = await jsonResponse(
    await request(studio, '/api/query', {
      body: {
        databaseId: database.id,
        statement:
          'SELECT details, sequence FROM records WHERE sequence >= $minimum ORDER BY sequence LIMIT 2',
        parameters: encodeWire({ $minimum: 4 }),
      },
    }),
  )
  const parameterizedRows = decodeWire(parameterized.rows)
  assert.equal(parameterizedRows.every((row) => Number.isInteger(row.object_id)), true)
  assert.deepEqual(parameterizedRows.map(({ object_id: _objectId, ...row }) => row), [
    { details: { parity: 'even' }, sequence: 4 },
    { details: { parity: 'odd' }, sequence: 5 },
  ])

  for (const statement of [
    'FIND records',
    'DELETE FROM records WHERE sequence = 0',
    'UPDATE records SET sequence = 9',
    'SELECT * FROM records; DELETE FROM records',
    'SELECT * FROM records /* a semicolon ; inside a comment */; /* second */ DELETE FROM records',
    "SELECT * FROM records WHERE label = 'x\\'; DELETE FROM records; -- '",
  ]) {
    const rejected = await request(studio, '/api/query', {
      body: {
        databaseId: database.id,
        statement,
        parameters: encodeWire([]),
      },
    })
    assert.equal(rejected.status, 400, statement)
    assert.match((await jsonResponse(rejected)).error.message, /SELECT|statement/i)
  }

  const countResult = await jsonResponse(
    await request(studio, '/api/query', {
      body: {
        databaseId: database.id,
        statement: 'SELECT COUNT(*) AS count FROM records',
        parameters: encodeWire([]),
      },
    }),
  )
  assert.deepEqual(decodeWire(countResult.rows), [{ count: 6 }])
})

test('refresh discovers newly created immediate databases and diagnostics maintenance works', async (t) => {
  const fixture = await createFixture(t, 'node-idb-studio-refresh-')
  await writeDocuments(fixture.rootPath, 'root_items', [{ value: 1 }])
  const studio = await fixture.start({ writable: true })
  const initial = await jsonResponse(await request(studio, '/api/state'))
  assert.equal(initial.databases.length, 1)

  await writeDocuments(path.join(fixture.rootPath, 'later'), 'later_items', [
    { value: 2 },
  ])
  const refreshedResponse = await request(studio, '/api/refresh', { body: {} })
  assert.equal(refreshedResponse.status, 200)
  await jsonResponse(refreshedResponse)
  const refreshed = await jsonResponse(await request(studio, '/api/state'))
  assert.equal(refreshed.databases.length, 2)
  const database = databaseWithCollection(refreshed, 'later_items')

  const diagnostics = await request(
    studio,
    `/api/databases/${encodeURIComponent(database.id)}/diagnostics`,
  )
  assert.equal(diagnostics.status, 200)
  assert.match(JSON.stringify(await jsonResponse(diagnostics)), /later_items/)

  const analyzed = await request(
    studio,
    `/api/databases/${encodeURIComponent(database.id)}/analyze`,
    { body: {} },
  )
  assert.equal(analyzed.status, 200)
  assert.equal(typeof (await jsonResponse(analyzed)), 'object')

  const optimized = await request(
    studio,
    `/api/databases/${encodeURIComponent(database.id)}/optimize-indexes`,
    { body: { dryRun: true } },
  )
  assert.equal(optimized.status, 200)
  assert.equal(typeof (await jsonResponse(optimized)), 'object')
})
