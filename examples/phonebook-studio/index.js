import path from 'node:path'
import { parseArgs } from 'node:util'

import { startStudio } from 'node-idb/studio'

import { DEFAULT_PHONEBOOK_CONFIG } from './data.js'
import { seedPhonebook } from './seed.js'

const help = `
node-idb Phonebook Studio sample

Usage:
  node examples/phonebook-studio/index.js [options]

Options:
  --root=<path>          Studio root (default: ./.example-data/phonebook-studio)
  --port=<number>        Loopback port; 0 chooses a free port (default: 4177)
  --readonly             Browse without enabling Studio writes
  --reseed               Replace the known sample collections
  --seed=<number>        Deterministic RNG seed (default: ${DEFAULT_PHONEBOOK_CONFIG.seed})
  --companies=<number>   Company documents (default: ${DEFAULT_PHONEBOOK_CONFIG.companyCount})
  --groups=<number>      Group documents (default: ${DEFAULT_PHONEBOOK_CONFIG.groupCount})
  --contacts=<number>    Contact documents (default: ${DEFAULT_PHONEBOOK_CONFIG.contactCount})
  --memberships=<number> Group membership documents (default: ${DEFAULT_PHONEBOOK_CONFIG.membershipCount})
  --interactions=<number> Interaction documents (default: ${DEFAULT_PHONEBOOK_CONFIG.interactionCount})
  --batch-size=<number>  Documents per INSERT command (default: 250)
  --help                 Show this help

Examples:
  node examples/phonebook-studio/index.js
  node examples/phonebook-studio/index.js --port=0
  node examples/phonebook-studio/index.js --contacts=100 --memberships=200 --interactions=400 --reseed
`

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: './.example-data/phonebook-studio' },
    port: { type: 'string', default: '4177' },
    readonly: { type: 'boolean', default: false },
    reseed: { type: 'boolean', default: false },
    seed: { type: 'string' },
    companies: { type: 'string' },
    groups: { type: 'string' },
    contacts: { type: 'string' },
    memberships: { type: 'string' },
    interactions: { type: 'string' },
    'batch-size': { type: 'string', default: '250' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
})

/** @param {string} label @param {string | undefined} value @param {number} minimum @param {number} maximum */
function integerOption(label, value, minimum, maximum) {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be an integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be from ${minimum} through ${maximum}`)
  }
  return number
}

async function main() {
  if (typeof values.root !== 'string' || !values.root.trim()) {
    throw new TypeError('--root must be a non-empty path dedicated to this sample')
  }
  const rootPath = path.resolve(values.root)
  const storagePath = path.join(rootPath, 'phonebook')
  const port = integerOption('--port', values.port, 0, 65_535)
  const batchSize = integerOption('--batch-size', values['batch-size'], 1, 2_000)
  const config = Object.fromEntries(Object.entries({
    seed: integerOption('--seed', values.seed, 0, 0xffff_ffff),
    companyCount: integerOption('--companies', values.companies, 1, 500),
    groupCount: integerOption('--groups', values.groups, 1, 200),
    contactCount: integerOption('--contacts', values.contacts, 1, 10_000),
    membershipCount: integerOption('--memberships', values.memberships, 1, 50_000),
    interactionCount: integerOption('--interactions', values.interactions, 1, 50_000),
  }).filter(([, value]) => value !== undefined))

  console.log(`Phonebook database: ${storagePath}`)
  const result = await seedPhonebook({
    storagePath,
    config,
    reseed: values.reseed,
    batchSize,
    onProgress: (message) => console.log(message),
  })
  console.log(
    `${result.seeded ? 'Created' : 'Reused'} ${result.counts.total.toLocaleString('en-US')} sample documents ` +
    `in ${result.elapsedMs.toLocaleString('en-US')} ms.`,
  )

  const studio = await startStudio({
    rootPath,
    port,
    writable: !values.readonly,
  })
  console.log(`Open node-idb Studio: ${studio.url}`)
  console.log(`Mode: ${studio.writable ? 'writable sample' : 'read-only'}`)
  console.log('Press Ctrl+C to close Studio.')

  let closing = false
  async function shutdown() {
    if (closing) return
    closing = true
    try {
      await studio.close()
    } catch (error) {
      console.error('Could not close Studio cleanly:', error)
      process.exitCode = 1
    }
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

if (values.help) {
  console.log(help.trim())
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
