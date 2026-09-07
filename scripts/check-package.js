import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this check with npm run test:package')
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'node-idb-package-check-'))
const consumer = path.join(temporaryRoot, 'consumer')

async function run(file, args, cwd) {
  try {
    return await exec(file, args, { cwd, timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`${file} failed: ${error.stderr || error.stdout || error.message}`, { cause: error })
  }
}

try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', temporaryRoot], root)
  const [archive] = JSON.parse(packed.stdout)
  assert.equal(archive.version, manifest.version)
  await mkdir(consumer)
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const typescript = lock.packages['node_modules/typescript'].version
  // Use the real tarball and real install scripts: this validates native SQLite
  // installation and catches missing files that repository self-imports hide.
  await run(process.execPath, [npm, 'install', '--no-audit', '--no-fund', '--save-exact',
    path.join(temporaryRoot, archive.filename), `typescript@${typescript}`], consumer)
  for (const [source, target] of [['package-consumer.mjs', 'smoke.mjs'], ['package-consumer.ts', 'smoke.ts']]) {
    await copyFile(path.join(root, 'scripts', source), path.join(consumer, target))
  }
  await run(process.execPath, ['smoke.mjs'], consumer)
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--skipLibCheck',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'smoke.ts'], consumer)
  // npm exec resolves the installed bin entry and its platform-specific shim.
  const cli = await run(process.execPath, [npm, 'exec', '--offline', '--', 'node-idb', 'inspect',
    path.join(consumer, 'data'), '--json'], consumer)
  assert.equal(JSON.parse(cli.stdout).collections.length, 1)
  console.log(`Packed node-idb@${manifest.version}: fresh install, API, Studio assets/API, CLI, and TypeScript passed.`)
} finally {
  const resolved = path.resolve(temporaryRoot)
  const relative = path.relative(os.tmpdir(), resolved)
  if (!relative.startsWith('node-idb-package-check-') || relative.includes(path.sep)) {
    throw new Error('Refusing to clean an unexpected package-check directory')
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
