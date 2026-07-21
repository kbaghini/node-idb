#!/usr/bin/env node

import { createIdb, inspectStorage, restoreBackup, verifyBackup } from '../src/index.js'

const help = `node-idb maintenance CLI

Usage:
  node-idb inspect <storage-path> [--integrity none|quick|full] [--json]
  node-idb verify-backup <backup-path> [--full] [--json]
  node-idb restore <backup-path> <destination-path> [--overwrite] [--full] [--json]
  node-idb migrate <storage-path> --yes [--field-indexes auto|all|none] [--json]

The migrate command is deliberately explicit: stop every process using the
storage, make a verified backup, then pass --yes. Inspection never migrates.`

function parseArguments(arguments_) {
  const positionals = []
  const options = {}
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (['json', 'full', 'overwrite', 'yes', 'help'].includes(name)) {
      options[name] = true
      continue
    }
    if (['integrity', 'field-indexes'].includes(name)) {
      const value = arguments_[++index]
      if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
      options[name] = value
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return { positionals, options }
}

function requirePositionals(positionals, count, command) {
  if (positionals.length !== count) {
    throw new Error(`${command} expects ${count} path argument${count === 1 ? '' : 's'}`)
  }
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(help)
    return
  }
  const { positionals, options } = parseArguments(arguments_)
  let result
  if (command === 'inspect') {
    requirePositionals(positionals, 1, command)
    result = await inspectStorage({
      storagePath: positionals[0],
      integrityCheck: options.integrity || 'quick',
    })
  } else if (command === 'verify-backup') {
    requirePositionals(positionals, 1, command)
    result = await verifyBackup({
      backupPath: positionals[0],
      integrityCheck: options.full ? 'full' : 'quick',
    })
  } else if (command === 'restore') {
    requirePositionals(positionals, 2, command)
    result = await restoreBackup({
      backupPath: positionals[0],
      destinationPath: positionals[1],
      overwrite: Boolean(options.overwrite),
      integrityCheck: options.full ? 'full' : 'quick',
    })
  } else if (command === 'migrate') {
    requirePositionals(positionals, 1, command)
    if (!options.yes) {
      throw new Error('migrate requires --yes after you stop writers and create a verified backup')
    }
    const fieldIndexes = options['field-indexes'] || 'auto'
    if (!['auto', 'all', 'none'].includes(fieldIndexes)) {
      throw new Error('--field-indexes must be auto, all, or none')
    }
    const before = await inspectStorage({ storagePath: positionals[0], integrityCheck: 'quick' })
    const database = createIdb({ storagePath: positionals[0], fieldIndexes })
    try {
      for (const collection of before.collections) {
        await database.execute(`SELECT * FROM ${quoteIdentifier(collection.collection)} LIMIT 0`)
      }
    } finally {
      await database.close()
    }
    const after = await inspectStorage({ storagePath: positionals[0], integrityCheck: 'quick' })
    result = Object.freeze({ before, after })
  } else {
    throw new Error(`Unknown command: ${command}`)
  }

  console.log(JSON.stringify(result, null, options.json ? 2 : 2))
}

main().catch((error) => {
  console.error(`node-idb: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
