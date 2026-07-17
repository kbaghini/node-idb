// @ts-check

import sqlite3 from 'sqlite3'

/** @typedef {import('sqlite3').Database} Database */

/**
 * @param {string} filename
 * @returns {Promise<Database>}
 */
export function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) => {
      if (error) reject(error)
      else resolve(database)
    })
  })
}

/**
 * @param {Database} database
 * @param {string} sql
 * @returns {Promise<void>}
 */
export function exec(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * @param {Database} database
 * @param {string} sql
 * @param {unknown[] | Record<string, unknown>} [parameters]
 * @returns {Promise<{ lastID: number, changes: number }>}
 */
export function run(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, function onRun(error) {
      if (error) reject(error)
      else resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

/**
 * @template T
 * @param {Database} database
 * @param {string} sql
 * @param {unknown[] | Record<string, unknown>} [parameters]
 * @returns {Promise<T | undefined>}
 */
export function get(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, parameters, (error, row) => {
      if (error) reject(error)
      else resolve(/** @type {T | undefined} */ (row))
    })
  })
}

/**
 * @template T
 * @param {Database} database
 * @param {string} sql
 * @param {unknown[] | Record<string, unknown>} [parameters]
 * @returns {Promise<T[]>}
 */
export function all(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows) => {
      if (error) reject(error)
      else resolve(/** @type {T[]} */ (rows))
    })
  })
}

/**
 * @param {Database} database
 * @returns {Promise<void>}
 */
export function closeDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** @param {string} value */
export function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/** @param {string} value */
export function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Executes a transaction and rolls it back on every failure.
 *
 * @template T
 * @param {Database} database
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function transaction(database, operation) {
  await exec(database, 'BEGIN IMMEDIATE')
  try {
    const result = await operation()
    await exec(database, 'COMMIT')
    return result
  } catch (error) {
    try {
      await exec(database, 'ROLLBACK')
    } catch {
      // Preserve the operation error; SQLite may already have rolled back.
    }
    throw error
  }
}

/**
 * @template T
 * @param {T[]} values
 * @param {number} [size]
 * @returns {T[][]}
 */
export function chunks(values, size = 400) {
  const result = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}
