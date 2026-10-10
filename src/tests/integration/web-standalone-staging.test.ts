import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, readFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Load the packaging helper the way the build invokes it (a CommonJS script).
const require = createRequire(import.meta.url)
const staging = require(join(process.cwd(), 'scripts', 'stage-web-standalone.cjs')) as {
  hoistPnpmVirtualStore: (nodeModulesRoot: string) => number
  stageWebStandalone: (root: string, options?: { variant: string }) => void
  verifyOpenClawDependencies: (root: string) => void
  OPENCLAW_WEB_BASE_PATH: string
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


function buildHostFixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'gsd-stage-variants-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'web'), { recursive: true })
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, 'web/package.json'), JSON.stringify({ name: 'gsd-web', dependencies: { '@gsd/pi-ai': 'workspace:*' } }))
  for (const [distDir, basePath] of [['.next', ''], ['.next-openclaw', staging.OPENCLAW_WEB_BASE_PATH]]) {
    const buildRoot = join(root, 'web', distDir)
    const app = join(buildRoot, 'standalone/web')
    mkdirSync(join(app, distDir), { recursive: true })
    mkdirSync(join(buildRoot, 'static'), { recursive: true })
    writeFileSync(join(buildRoot, 'required-server-files.json'), JSON.stringify({ config: { basePath } }))
    writeFileSync(join(buildRoot, 'static/chunk.js'), '/* asset */')
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'gsd-web', version: '1.0.0', dependencies: { '@gsd/pi-ai': 'workspace:*' } }))
    writeFileSync(join(app, distDir, 'route.json'), JSON.stringify(basePath))
    // Like Next's generated entry, resolve dependencies beside this app and
    // load build-specific files relative to its own server.js, not the cwd.
    writeFileSync(join(app, 'server.js'), `require('next'); process.stdout.write(require('./${distDir}/route.json'))`)
    const deps = join(buildRoot, 'standalone/node_modules')
    mkdirSync(deps, { recursive: true })
    buildPnpmFixture(deps)
  }
  return root
}

function runStagedHost(entry: string): string {
  return execFileSync(process.execPath, [entry], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('root and prefixed staged server entries resolve one shared, pack-safe dependency tree', (t) => {
  const root = buildHostFixture(t)
  staging.stageWebStandalone(root)
  staging.stageWebStandalone(root, { variant: 'openclaw' })
  const shared = join(root, 'dist/web/standalone')
  const embedded = join(shared, 'openclaw')
  assert.equal(runStagedHost(join(shared, 'server.js')), 'OK')
  assert.equal(runStagedHost(join(embedded, 'server.js')), `OK${staging.OPENCLAW_WEB_BASE_PATH}`)
  assert.equal(existsSync(join(embedded, 'node_modules')), false, 'the variant must not duplicate the shared dependency payload')
  assert.ok(existsSync(join(embedded, '.next-openclaw/static/chunk.js')))
  assert.ok(existsSync(join(shared, '.next/static/chunk.js')))
  assert.deepEqual(findSymlinks(shared), [])
  const plainMetadata = JSON.parse(readFileSync(join(shared, 'gsd-web-build.json'), 'utf8'))
  const embeddedMetadata = JSON.parse(readFileSync(join(embedded, 'gsd-web-build.json'), 'utf8'))
  assert.equal(plainMetadata.basePath, '')
  assert.equal(embeddedMetadata.basePath, staging.OPENCLAW_WEB_BASE_PATH)
  assert.equal(plainMetadata.dependencyHash, embeddedMetadata.dependencyHash)

  // Ordinary rebuilds retain a usable variant only while dependency versions
  // match; a changed lockfile requires rebuilding it against the new parent.
  staging.stageWebStandalone(root)
  assert.equal(runStagedHost(join(embedded, 'server.js')), `OK${staging.OPENCLAW_WEB_BASE_PATH}`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# changed dependencies\n')
  assert.throws(() => staging.verifyOpenClawDependencies(root), /shared dependencies are missing or stale/)
  staging.stageWebStandalone(root)
  assert.equal(existsSync(embedded), false)
  assert.ok(existsSync(join(root, 'dist/.web-previous/standalone/openclaw/server.js')), 'incompatible previous generation remains available for rollback')
  staging.stageWebStandalone(root, { variant: 'openclaw' })
  assert.equal(runStagedHost(join(embedded, 'server.js')), `OK${staging.OPENCLAW_WEB_BASE_PATH}`)
})

test('missing shared host and accidentally cross-staged base paths fail before replacing current output', (t) => {
  const root = buildHostFixture(t)
  assert.throws(() => staging.stageWebStandalone(root, { variant: 'openclaw' }), /Build the ordinary standalone host/)
  staging.stageWebStandalone(root)
  const entry = join(root, 'dist/web/standalone/server.js')
  const original = readFileSync(entry, 'utf8')
  writeFileSync(join(root, 'web/.next/required-server-files.json'), JSON.stringify({ config: { basePath: staging.OPENCLAW_WEB_BASE_PATH } }))
  assert.throws(() => staging.stageWebStandalone(root), /Next.js basePath cannot be changed at runtime/)
  assert.equal(readFileSync(entry, 'utf8'), original)
  writeFileSync(join(root, 'web/.next-openclaw/required-server-files.json'), JSON.stringify({ config: { basePath: '' } }))
  assert.throws(() => staging.stageWebStandalone(root, { variant: 'openclaw' }), /Next.js basePath cannot be changed at runtime/)
  assert.equal(runStagedHost(entry), 'OK')
})

test('npm payload includes both variants and shared dependencies but no rollback or workspace protocol leaks', (t) => {
  const root = buildHostFixture(t)
  staging.stageWebStandalone(root)
  staging.stageWebStandalone(root, { variant: 'openclaw' })
  staging.stageWebStandalone(root)
  staging.stageWebStandalone(root, { variant: 'openclaw' })
  const repositoryPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gsd-stage-test', version: '1.0.0', files: repositoryPackage.files }))
  for (const name of ['prepack-resolve-workspace.cjs', 'postpack-restore-workspace.cjs', 'lib/version-sync.cjs']) {
    const target = join(root, 'scripts', name)
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(join(process.cwd(), 'scripts', name), target)
  }
  execFileSync(process.execPath, [join(root, 'scripts/prepack-resolve-workspace.cjs')], { stdio: 'pipe' })
  const manifests = ['dist/web/standalone/package.json', 'dist/web/standalone/openclaw/package.json']
  for (const manifest of manifests) assert.ok(!readFileSync(join(root, manifest), 'utf8').includes('workspace:'), manifest)
  const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32',
    env: { ...process.env, npm_config_cache: join(root, '.npm-cache'), npm_config_update_notifier: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }))[0].files.map((file: { path: string }) => file.path) as string[]
  for (const path of [
    'dist/web/standalone/server.js', 'dist/web/standalone/openclaw/server.js',
    'dist/web/standalone/node_modules/next/index.js',
    'dist/web/standalone/openclaw/.next-openclaw/static/chunk.js',
  ]) assert.ok(packed.includes(path), `${path} must survive npm pack`)
  assert.ok(!packed.some(path => path.startsWith('dist/.web-')), 'rollback and staging trees must not bloat or leak into the package')
  execFileSync(process.execPath, [join(root, 'scripts/postpack-restore-workspace.cjs')], { stdio: 'pipe' })
  for (const manifest of manifests) assert.ok(readFileSync(join(root, manifest), 'utf8').includes('workspace:'), `${manifest} must be restored after packing`)
})
