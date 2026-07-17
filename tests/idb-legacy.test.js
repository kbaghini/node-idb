import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import sqlite3 from 'sqlite3'

import { createIdb } from '../src/index.js'

function open(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(database))
  })
}

function exec(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => error ? reject(error) : resolve())
  })
}

function run(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, (error) => error ? reject(error) : resolve())
  })
}

function close(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve())
  })
}

test('opens and upgrades a populated legacy v0 database in place', async (context) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-idb-v0-'))
  context.after(() => fs.rmSync(storagePath, { recursive: true, force: true }))
  const projectDirectory = path.join(storagePath, '-system-')
  fs.mkdirSync(projectDirectory, { recursive: true })
  const mainPath = path.join(projectDirectory, 'db-collection-files.sqlite')
  const blobPath = path.join(projectDirectory, 'db-blobs-files.sqlite')

  const main = await open(mainPath)
  await exec(main, `
    PRAGMA user_version=0;
    CREATE TABLE tbl_record (collection varchar(255) unique not null, last_record_id integer default 0);
    CREATE TABLE tbl_fields (
      id integer primary key autoincrement,
      name varchar(255),
      level integer,
      parent_field_id integer,
      unique(name, parent_field_id)
    );
    INSERT INTO tbl_record VALUES ('files', 3);
    INSERT INTO tbl_fields (id, name, level, parent_field_id) VALUES
      (1, 'files', 0, NULL), (2, 'key', 1, 1), (3, 'content', 1, 1);
    CREATE TABLE tbl_values_1 (id integer primary key, type integer, number numeric, string varchar(255), parent_id integer, object_id integer);
    CREATE TABLE tbl_values_2 (id integer primary key, type integer, number numeric, string varchar(255), parent_id integer, object_id integer);
    CREATE TABLE tbl_values_3 (id integer primary key, type integer, number numeric, string varchar(255), parent_id integer, object_id integer);
    INSERT INTO tbl_values_1 VALUES (1, 9, 2, NULL, NULL, 1);
    INSERT INTO tbl_values_2 VALUES (2, 6, NULL, 'legacy-key', 1, 1);
    INSERT INTO tbl_values_3 VALUES (3, 10, NULL, NULL, 1, 1);
  `)
  await close(main)

  const blobs = await open(blobPath)
  await exec(blobs, 'CREATE TABLE tbl_blobs (id integer primary key, blob blob, object_id integer)')
  await run(blobs, 'INSERT INTO tbl_blobs VALUES (?, ?, ?)', [3, Buffer.from('legacy-content'), 1])
  await close(blobs)

  const idb = createIdb({ storagePath })
  assert.deepEqual(await idb.execute('-system-', "get files where key='legacy-key'"), [
    { key: 'legacy-key', content: Buffer.from('legacy-content') },
  ])
  await idb.execute(
    '-system-',
    "insert or replace into files where key='legacy-key'",
    { key: 'legacy-key', content: Buffer.from('new-content'), zip: true },
  )
  assert.deepEqual(await idb.execute('-system-', "get files where key='legacy-key'"), [
    { key: 'legacy-key', content: Buffer.from('new-content'), zip: true },
  ])
  await idb.close()

  const reopened = await open(mainPath)
  const version = await new Promise((resolve, reject) => {
    reopened.get('PRAGMA user_version', (error, row) => error ? reject(error) : resolve(row.user_version))
  })
  assert.equal(version, 3)
  await close(reopened)
})

test('supports the legacy portal callback flow and fire-and-forget calls', async (context) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-idb-callback-'))
  context.after(() => fs.rmSync(storagePath, { recursive: true, force: true }))
  const idb = createIdb({ storagePath })

  const callbackResult = (statement, parameters) => new Promise((resolve, reject) => {
    idb.run('-system-', statement, parameters, (error, result) => error ? reject(error) : resolve(result))
  })

  await callbackResult('insert into files', {
    key: 'portal.js',
    content: Buffer.from('source'),
    mtimeMs: 123,
    zip: false,
    ext: '.js',
    rdate: 'old',
  })
  await idb.run('-system-', "update files set rdate='new' where key='portal.js'")
  assert.deepEqual(await callbackResult("get files where key='portal.js'"), [{
    key: 'portal.js',
    content: Buffer.from('source'),
    mtimeMs: 123,
    zip: false,
    ext: '.js',
    rdate: 'new',
  }])
  await callbackResult("delete files from files where key='portal.js'")
  assert.deepEqual(await callbackResult("get files where key='portal.js'"), [])
  await idb.close()
})

test('serializes concurrent first-use writes across independent engine instances', async (context) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-idb-concurrency-'))
  context.after(() => fs.rmSync(storagePath, { recursive: true, force: true }))
  const first = createIdb({ storagePath })
  const second = createIdb({ storagePath })

  const inserts = Array.from({ length: 40 }, (_, index) =>
    (index % 2 ? first : second).execute('shared', 'insert into events', {
      index,
      nested: { parity: index % 2 },
    }),
  )
  const ids = await Promise.all(inserts)
  assert.equal(new Set(ids).size, 40)
  const rows = await first.execute('shared', 'select "index" from events order by "index"')
  assert.deepEqual(rows.map((row) => row.index), Array.from({ length: 40 }, (_, index) => index))
  await Promise.all([first.close(), second.close()])
})
