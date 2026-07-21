import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createIdb } from 'node-idb'
import { startStudio } from 'node-idb/studio'

import {
  createSeededRandom,
  generateContacts,
  generateInteractions,
  validatePhonebookConfig,
} from '../examples/phonebook-studio/data.js'
import { seedPhonebook } from '../examples/phonebook-studio/seed.js'

const config = Object.freeze({
  seed: 7,
  companyCount: 3,
  groupCount: 4,
  contactCount: 12,
  membershipCount: 20,
  interactionCount: 30,
})

const tinyConfig = Object.freeze({
  seed: 11,
  companyCount: 2,
  groupCount: 2,
  contactCount: 6,
  membershipCount: 8,
  interactionCount: 10,
})

test('Phonebook generators reject malformed relationship inputs', () => {
  const normalized = validatePhonebookConfig(config)
  assert.throws(() => generateContacts(normalized, Array(3)), /object IDs/)
  assert.throws(() => generateContacts(normalized, [1, 1, 2]), /unique/)
  assert.throws(
    () => generateInteractions(normalized, Array.from({ length: 12 }, () => ({})),
      Array.from({ length: 12 }, (_, index) => index + 1)),
    /companyRef/,
  )
  assert.throws(() => createSeededRandom(1).boolean(1.1), /probability/)
})

test('Phonebook seeding rejects concurrent writers and keeps exact counts', async (t) => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'node-idb-phonebook-concurrent-'))
  const storagePath = path.join(rootPath, 'phonebook')
  t.after(() => rm(rootPath, { recursive: true, force: true }))

  await mkdir(storagePath, { recursive: true })
  const externalLock = path.join(storagePath, '.node-idb-phonebook-seed.lock')
  await writeFile(externalLock, JSON.stringify({ pid: 999_999, token: 'external-test' }))
  await assert.rejects(
    seedPhonebook({ storagePath, config: tinyConfig }),
    /Another Phonebook seeder/,
  )
  await rm(externalLock)

  const results = await Promise.allSettled([
    seedPhonebook({ storagePath, config: tinyConfig, batchSize: 1 }),
    seedPhonebook({ storagePath, config: tinyConfig, batchSize: 1 }),
  ])
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
  assert.match(
    String(results.find(({ status }) => status === 'rejected').reason),
    /already being seeded|Another Phonebook seeder/,
  )

  const database = createIdb({ storagePath })
  try {
    for (const [collection, expected] of [
      ['companies', tinyConfig.companyCount],
      ['groups', tinyConfig.groupCount],
      ['contacts', tinyConfig.contactCount],
      ['group_memberships', tinyConfig.membershipCount],
      ['interactions', tinyConfig.interactionCount],
      ['phonebook_meta', 1],
    ]) {
      const [{ total }] = await database.execute(`SELECT COUNT(*) AS total FROM ${collection}`)
      assert.equal(total, expected, collection)
    }
  } finally {
    await database.close()
  }
})

test('Phonebook seeding refuses unowned non-empty storage without explicit reseed', async (t) => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'node-idb-phonebook-unowned-'))
  const storagePath = path.join(rootPath, 'phonebook')
  t.after(() => rm(rootPath, { recursive: true, force: true }))

  const existing = createIdb({ storagePath })
  try {
    await existing.execute('INSERT INTO contacts', { sentinel: 'must survive refusal' })
  } finally {
    await existing.close()
  }

  await assert.rejects(
    seedPhonebook({ storagePath, config: tinyConfig }),
    /no Phonebook ownership state/,
  )

  const unchanged = createIdb({ storagePath })
  try {
    const contacts = await unchanged.execute('SELECT * FROM contacts')
    assert.deepEqual(contacts, [{ sentinel: 'must survive refusal' }])
  } finally {
    await unchanged.close()
  }

  const rebuilt = await seedPhonebook({
    storagePath,
    config: tinyConfig,
    reseed: true,
  })
  assert.equal(rebuilt.seeded, true)
  assert.equal(rebuilt.counts.total, 28)

  const readyPath = path.join(storagePath, '.node-idb-phonebook-seed.ready.json')
  const olderReady = JSON.parse(await readFile(readyPath, 'utf8'))
  olderReady.seedVersion = 1
  await writeFile(readyPath, JSON.stringify(olderReady))
  await assert.rejects(
    seedPhonebook({ storagePath, config: tinyConfig }),
    /older seed schema.*--reseed/,
  )
  assert.equal((await seedPhonebook({
    storagePath,
    config: tinyConfig,
    reseed: true,
  })).seeded, true)
})

test('Phonebook sample seeds valid relationships, preserves edits, and safely reseeds', async (t) => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'node-idb-phonebook-example-'))
  const storagePath = path.join(rootPath, 'phonebook')
  t.after(() => rm(rootPath, { recursive: true, force: true }))

  const created = await seedPhonebook({ storagePath, config, batchSize: 7 })
  assert.equal(created.seeded, true)
  assert.deepEqual(created.counts, {
    companies: 3,
    groups: 4,
    contacts: 12,
    groupMemberships: 20,
    interactions: 30,
    total: 69,
  })

  const database = createIdb({ storagePath })
  let firstCompanyId
  try {
    const companies = await database.execute('SELECT * FROM companies ORDER BY companyCode')
    const companyRows = await database.execute('SELECT object_id FROM companies ORDER BY object_id')
    const groups = await database.execute('SELECT * FROM groups ORDER BY groupCode')
    const groupRows = await database.execute('SELECT object_id FROM groups ORDER BY object_id')
    const contacts = await database.execute('SELECT * FROM contacts ORDER BY contactCode')
    const contactRows = await database.execute(
      'SELECT object_id, companyRef FROM contacts ORDER BY object_id',
    )
    const memberships = await database.execute(
      'SELECT contactRef, groupRef FROM group_memberships ORDER BY object_id',
    )
    const interactions = await database.execute(
      'SELECT contactRef, companyRef FROM interactions ORDER BY object_id',
    )

    assert.equal(companies.length, config.companyCount)
    assert.equal(groups.length, config.groupCount)
    assert.equal(contacts.length, config.contactCount)
    assert.equal(memberships.length, config.membershipCount)
    assert.equal(interactions.length, config.interactionCount)
    assert.equal(typeof companies[0].annualRevenue, 'bigint')
    assert.equal(Buffer.isBuffer(companies[0].logoBytes), true)
    assert.equal(contacts[0].birthday instanceof Date, true)
    assert.equal(Array.isArray(contacts[0].phones), true)

    const companyIds = new Set(companyRows.map(({ object_id }) => object_id))
    const groupIds = new Set(groupRows.map(({ object_id }) => object_id))
    const contactsById = new Map(contactRows.map((contact) => [contact.object_id, contact]))
    firstCompanyId = companyRows[0].object_id

    assert.equal(
      contactRows.every((contact) =>
        contact.companyRef.collection === 'companies' &&
        companyIds.has(contact.companyRef.objectId)),
      true,
    )
    assert.equal(
      groups.every((group) =>
        group.sponsorCompanyRef === null ||
        (group.sponsorCompanyRef.collection === 'companies' &&
          companyIds.has(group.sponsorCompanyRef.objectId))),
      true,
    )
    assert.equal(
      memberships.every((membership) =>
        membership.contactRef.collection === 'contacts' &&
        contactsById.has(membership.contactRef.objectId) &&
        membership.groupRef.collection === 'groups' &&
        groupIds.has(membership.groupRef.objectId)),
      true,
    )
    assert.equal(
      new Set(memberships.map((membership) =>
        `${membership.contactRef.objectId}:${membership.groupRef.objectId}`)).size,
      memberships.length,
    )
    assert.equal(
      interactions.every((interaction) => {
        const contact = contactsById.get(interaction.contactRef.objectId)
        return interaction.contactRef.collection === 'contacts' &&
          interaction.companyRef.collection === 'companies' &&
          contact?.companyRef.objectId === interaction.companyRef.objectId
      }),
      true,
    )

    const relatedCompanyId = contactRows[0].companyRef.objectId
    const relatedContacts = await database.execute(
      'SELECT object_id, displayName, companyRef FROM contacts WHERE companyRef.objectId = ?',
      [relatedCompanyId],
    )
    assert.ok(relatedContacts.length > 0)
    assert.equal(
      relatedContacts.every((contact) => contact.companyRef.objectId === relatedCompanyId),
      true,
    )

    await database.execute('INSERT INTO contacts', {
      contactCode: 'MANUAL-STUDIO-EDIT',
      displayName: 'Preserved manual edit',
      companyRef: { collection: 'companies', objectId: firstCompanyId },
    })
  } finally {
    await database.close()
  }

  const reused = await seedPhonebook({ storagePath, config, batchSize: 7 })
  assert.equal(reused.seeded, false)

  const withEdit = createIdb({ storagePath })
  try {
    const [{ total }] = await withEdit.execute('SELECT COUNT(*) AS total FROM contacts')
    assert.equal(total, config.contactCount + 1)
  } finally {
    await withEdit.close()
  }

  await assert.rejects(
    seedPhonebook({
      storagePath,
      config: { ...config, interactionCount: config.interactionCount + 1 },
    }),
    /--reseed/,
  )

  const editedMetadata = createIdb({ storagePath })
  try {
    await editedMetadata.execute(
      "UPDATE phonebook_meta SET relationshipModel = 'tampered'",
    )
  } finally {
    await editedMetadata.close()
  }
  await assert.rejects(
    seedPhonebook({ storagePath, config }),
    /metadata is missing|metadata.*edited/,
  )
  const deletedMetadata = createIdb({ storagePath })
  try {
    await deletedMetadata.execute('DELETE FROM phonebook_meta')
  } finally {
    await deletedMetadata.close()
  }
  await assert.rejects(
    seedPhonebook({ storagePath, config }),
    /metadata is missing|metadata.*edited/,
  )
  const afterMetadataRefusal = createIdb({ storagePath })
  try {
    const [{ total }] = await afterMetadataRefusal.execute(
      'SELECT COUNT(*) AS total FROM contacts',
    )
    assert.equal(total, config.contactCount + 1)
  } finally {
    await afterMetadataRefusal.close()
  }

  const rebuilt = await seedPhonebook({ storagePath, config, reseed: true, batchSize: 7 })
  assert.equal(rebuilt.seeded, true)

  const studio = await startStudio({ rootPath, port: 0 })
  try {
    const state = await studio.refresh()
    const phonebook = state.databases.find((databaseState) => databaseState.name === 'phonebook')
    assert.ok(phonebook)
    assert.deepEqual(
      phonebook.collections.map(({ name }) => name).sort(),
      ['companies', 'contacts', 'group_memberships', 'groups', 'interactions', 'phonebook_meta'],
    )
  } finally {
    await studio.close()
  }
})
