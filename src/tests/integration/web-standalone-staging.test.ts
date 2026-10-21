import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Load the packaging helper the way the build invokes it (a CommonJS script).
const require = createRequire(import.meta.url)
const staging = require(join(process.cwd(), 'scripts', 'stage-web-standalone.cjs')) as {
  hoistPnpmVirtualStore: (nodeModulesRoot: string) => number
}

/** Recursively assert no symbolic links remain (what `npm pack` would drop). */
function findSymlinks(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isSymbolicLink()) found.push(entryPath)
    else if (entry.isDirectory()) findSymlinks(entryPath, found)
  }
  return found
}

function writePackage(dir: string, name: string, indexBody: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), indexBody)
}

/**
 * Build a pnpm-style standalone `node_modules`: a `.pnpm/` virtual store holding
 * the real packages, top-level symlinks for the directly-depended packages, and
 * dependency-edge symlinks inside the store. This mirrors the exact layout that
 * crashes `gsd web` after publish (#328), where `next` depends on a NON-hoisted
 * `styled-jsx` and a scoped `@swc/helpers`.
 */
function buildPnpmFixture(nm: string): void {
  const pnpm = join(nm, '.pnpm')

  // Real packages in the store.
  writePackage(
    join(pnpm, 'next@16.2.4', 'node_modules', 'next'),
    'next',
    "require('react'); require('styled-jsx'); require('@swc/helpers'); process.stdout.write('OK')",
  )
  writePackage(join(pnpm, 'react@19.0.0', 'node_modules', 'react'), 'react', 'module.exports = {}')
  writePackage(join(pnpm, 'styled-jsx@5.1.0', 'node_modules', 'styled-jsx'), 'styled-jsx', 'module.exports = {}')
  writePackage(join(pnpm, '@swc+helpers@0.5.0', 'node_modules', '@swc', 'helpers'), '@swc/helpers', 'module.exports = {}')

  // Dependency-edge symlinks inside next's store entry.
  const nextNm = join(pnpm, 'next@16.2.4', 'node_modules')
  symlinkSync('../../react@19.0.0/node_modules/react', join(nextNm, 'react'))
  symlinkSync('../../styled-jsx@5.1.0/node_modules/styled-jsx', join(nextNm, 'styled-jsx'))
  mkdirSync(join(nextNm, '@swc'), { recursive: true })
  symlinkSync('../../../@swc+helpers@0.5.0/node_modules/@swc/helpers', join(nextNm, '@swc', 'helpers'))

  // Public top-level links pnpm lays down for the app's direct dependencies.
  symlinkSync('.pnpm/next@16.2.4/node_modules/next', join(nm, 'next'))
  symlinkSync('.pnpm/react@19.0.0/node_modules/react', join(nm, 'react'))
}

test('hoistPnpmVirtualStore flattens the .pnpm store into pack-safe real directories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-stage-hoist-'))
  const nm = join(root, 'node_modules')
  mkdirSync(nm, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  buildPnpmFixture(nm)

  const hoisted = staging.hoistPnpmVirtualStore(nm)
  assert.ok(hoisted >= 4, `expected at least 4 packages hoisted, got ${hoisted}`)

  // Every package is now a real top-level directory (survives npm pack).
  for (const pkg of ['next', 'react', 'styled-jsx']) {
    assert.ok(existsSync(join(nm, pkg)), `${pkg} should exist at top level`)
    assert.equal(lstatSync(join(nm, pkg)).isSymbolicLink(), false, `${pkg} must be a real dir, not a symlink`)
  }
  // The non-hoisted private dependency must be lifted to top level too — this is
  // the entry whose absence produced `Cannot find module` at runtime.
  assert.ok(existsSync(join(nm, 'styled-jsx', 'package.json')), 'styled-jsx must be materialised')
  assert.ok(existsSync(join(nm, '@swc', 'helpers', 'package.json')), 'scoped @swc/helpers must be materialised')

  // The store and all symlinks are gone — nothing left for npm pack to drop.
  assert.equal(existsSync(join(nm, '.pnpm')), false, '.pnpm store should be removed after flattening')
  assert.deepEqual(findSymlinks(nm), [], 'no symlinks should remain in the flattened tree')

  // Prove resolution works exactly as it would for a published, symlink-free
  // install: requiring `next` must transitively resolve its (now hoisted) deps.
  const output = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(join(nm, 'next'))})`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  assert.equal(output, 'OK', 'standalone host must resolve next and its transitive deps after flattening')
})

test('hoistPnpmVirtualStore is a no-op when there is no pnpm store', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-stage-noop-'))
  const nm = join(root, 'node_modules')
  writePackage(join(nm, 'next'), 'next', 'module.exports = {}')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(staging.hoistPnpmVirtualStore(nm), 0)
  assert.ok(existsSync(join(nm, 'next', 'package.json')), 'existing flat packages are left untouched')
})
