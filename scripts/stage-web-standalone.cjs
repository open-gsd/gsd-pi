#!/usr/bin/env node

const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  renameSync,
  readFileSync,
  writeFileSync,
} = require('node:fs')
const { createHash } = require('node:crypto')
const { dirname, join, resolve } = require('node:path')

const COPY_OPTIONS = {
  recursive: true,
  force: true,
  dereference: true,
}

function overlayNodePty(targetRoot, sourceNodePtyRoot, { sharedDependencies = false, distDir = '.next' } = {}) {
  if (!existsSync(sourceNodePtyRoot)) return []

  const hydrated = []
  if (!sharedDependencies) {
    const directTarget = join(targetRoot, 'node_modules', 'node-pty')
    mkdirSync(join(targetRoot, 'node_modules'), { recursive: true })
    cpSync(sourceNodePtyRoot, directTarget, COPY_OPTIONS)
    hydrated.push(directTarget)
  }

  const hashedNodeModulesRoot = join(targetRoot, distDir, 'node_modules')
  if (!existsSync(hashedNodeModulesRoot)) return hydrated

  for (const entry of readdirSync(hashedNodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('node-pty-')) continue
    const target = join(hashedNodeModulesRoot, entry.name)
    cpSync(sourceNodePtyRoot, target, COPY_OPTIONS)
    hydrated.push(target)
  }

  return hydrated
}

// ─── pnpm virtual store flattening ──────────────────────────────────────────
//
// pnpm lays dependencies down as symlinks into a `.pnpm/` virtual store, but
// `npm publish`/`npm pack` SILENTLY DROP symlinks from the tarball. The Next
// standalone output therefore loses its top-level `next`/`react`/`react-dom`
// entries (and every nested dependency edge) once published, and the host
// crashes on boot with `Cannot find module 'next'` (#328).
//
// `cpSync({ dereference: true })` does NOT help: it dereferences only the entry
// passed to it, leaving nested symlinks inside the tree intact. We instead
// flatten the store into a real, hoisted `node_modules` so every package
// survives packing as a plain directory and resolves by ordinary directory
// walking.

/**
 * Map every real package in the `.pnpm` store to its source directory, keyed by
 * package name. Within `.pnpm/<name>@<version>_<peers>/node_modules/`, the real
 * (non-symlink) directories are the packages themselves; sibling symlinks are
 * just dependency edges into other store entries.
 */
function collectStorePackages(pnpmRoot) {
  const packages = new Map()
  if (!existsSync(pnpmRoot)) return packages

  const record = (name, dir) => {
    if (!packages.has(name)) packages.set(name, dir)
  }

  for (const entry of readdirSync(pnpmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryNodeModules = join(pnpmRoot, entry.name, 'node_modules')
    if (!existsSync(entryNodeModules)) continue

    for (const pkg of readdirSync(entryNodeModules, { withFileTypes: true })) {
      if (pkg.isSymbolicLink() || pkg.name === '.bin') continue
      const pkgPath = join(entryNodeModules, pkg.name)

      if (pkg.name.startsWith('@')) {
        if (!pkg.isDirectory()) continue
        for (const scoped of readdirSync(pkgPath, { withFileTypes: true })) {
          if (scoped.isSymbolicLink() || !scoped.isDirectory()) continue
          record(`${pkg.name}/${scoped.name}`, join(pkgPath, scoped.name))
        }
        continue
      }

      if (pkg.isDirectory()) record(pkg.name, pkgPath)
    }
  }

  return packages
}

/**
 * Versions pnpm hoisted to the public top level win when the store holds more
 * than one copy of a package name. Read them straight off the (still-present)
 * top-level symlinks so the hoisted tree mirrors what pnpm itself resolved.
 */
function collectPreferredTopLevelTargets(nodeModulesRoot) {
  const preferred = new Map()

  const recordIfLink = (name, linkPath) => {
    try {
      if (!lstatSync(linkPath).isSymbolicLink()) return
      const real = realpathSync(linkPath)
      if (statSync(real).isDirectory()) preferred.set(name, real)
    } catch {
      // Dangling link — nothing usable to hoist.
    }
  }

  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (entry.name === '.pnpm') continue
    const entryPath = join(nodeModulesRoot, entry.name)
    if (entry.isSymbolicLink()) {
      recordIfLink(entry.name, entryPath)
    } else if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
        recordIfLink(`${entry.name}/${scoped.name}`, join(entryPath, scoped.name))
      }
    }
  }

  return preferred
}

function removeSymlinksRecursively(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      rmSync(entryPath, { force: true })
    } else if (entry.isDirectory()) {
      removeSymlinksRecursively(entryPath)
    }
  }
}

/**
 * Flatten a pnpm `.pnpm` virtual store into a real hoisted `node_modules`.
 * Returns the number of packages materialised. Idempotent on a store-free tree.
 */
function hoistPnpmVirtualStore(nodeModulesRoot) {
  const pnpmRoot = join(nodeModulesRoot, '.pnpm')
  if (!existsSync(pnpmRoot)) return 0

  const preferred = collectPreferredTopLevelTargets(nodeModulesRoot)
  const storePackages = collectStorePackages(pnpmRoot)

  let hoisted = 0
  const writePackage = (name, sourceDir) => {
    const segments = name.startsWith('@') ? name.split('/') : [name]
    const dest = join(nodeModulesRoot, ...segments)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(sourceDir, dest, COPY_OPTIONS)
    hoisted++
  }

  for (const [name, sourceDir] of storePackages) {
    writePackage(name, preferred.get(name) ?? sourceDir)
  }
  // A package may have been public-hoisted without a matching store entry name
  // (e.g. shipped only via a top-level link); honour those too.
  for (const [name, sourceDir] of preferred) {
    if (!storePackages.has(name)) writePackage(name, sourceDir)
  }

  // The store and every dependency-edge symlink into it are now redundant: each
  // package they referenced is resolvable from the flat top-level tree, and the
  // dangling links would not survive packing anyway.
  rmSync(pnpmRoot, { recursive: true, force: true })
  removeSymlinksRecursively(nodeModulesRoot)

  return hoisted
}

const OPENCLAW_WEB_BASE_PATH = '/plugins/open-gsd-openclaw/web'
const WEB_BUILD_METADATA = 'gsd-web-build.json'

function dependencyHash(root) {
  const hash = createHash('sha256')
  for (const relative of ['pnpm-lock.yaml', 'web/package.json']) {
    hash.update(relative)
    hash.update(readFileSync(join(root, relative)))
  }
  return hash.digest('hex')
}

function readBuildMetadata(appRoot) {
  try { return JSON.parse(readFileSync(join(appRoot, WEB_BUILD_METADATA), 'utf8')) } catch { return undefined }
}

function verifyOpenClawDependencies(root) {
  const sharedRoot = join(root, 'dist', 'web', 'standalone')
  const metadata = readBuildMetadata(sharedRoot)
  if (!existsSync(join(sharedRoot, 'server.js')) || !existsSync(join(sharedRoot, 'node_modules'))
    || metadata?.version !== 1 || metadata.basePath !== '' || metadata.dependencyHash !== dependencyHash(root)) {
    throw new Error('Build the ordinary standalone host with `pnpm run build:web-host` before the OpenClaw variant; its shared dependencies are missing or stale.')
  }
}

function stageWebStandalone(root = resolve(__dirname, '..'), { variant = 'standalone' } = {}) {
  if (!['standalone', 'openclaw'].includes(variant)) throw new Error(`Unknown web host variant: ${variant}`)
  const embedded = variant === 'openclaw'
  const distDir = embedded ? '.next-openclaw' : '.next'
  const basePath = embedded ? OPENCLAW_WEB_BASE_PATH : ''
  const webRoot = join(root, 'web')
  const standaloneRoot = join(webRoot, distDir, 'standalone')
  const standaloneAppRoot = join(standaloneRoot, 'web')
  const standaloneNodeModulesRoot = join(standaloneRoot, 'node_modules')
  const staticRoot = join(webRoot, distDir, 'static')
  const publicRoot = join(webRoot, 'public')
  const distWebRoot = embedded ? join(root, 'dist', 'web', 'standalone', 'openclaw') : join(root, 'dist', 'web')
  const stagingWebRoot = join(root, 'dist', embedded ? '.web-openclaw-staging' : '.web-staging')
  const distStandaloneRoot = embedded ? stagingWebRoot : join(stagingWebRoot, 'standalone')
  const sourceNodePtyRoot = join(webRoot, 'node_modules', 'node-pty')

  if (!existsSync(standaloneAppRoot)) {
    throw new Error(`Web standalone build not found at web/${distDir}/standalone/web. Build the ${variant} host first.`)
  }
  const compiled = JSON.parse(readFileSync(join(webRoot, distDir, 'required-server-files.json'), 'utf8'))
  if ((compiled.config?.basePath ?? '') !== basePath) {
    throw new Error(`Refusing to stage ${variant}: compiled basePath must be ${JSON.stringify(basePath)}. Next.js basePath cannot be changed at runtime.`)
  }
  if (embedded) verifyOpenClawDependencies(root)
  const metadata = { version: 1, basePath, dependencyHash: dependencyHash(root) }

  rmSync(stagingWebRoot, { recursive: true, force: true })
  mkdirSync(distStandaloneRoot, { recursive: true })

  cpSync(standaloneAppRoot, distStandaloneRoot, COPY_OPTIONS)
  // Both variants trace the same application/dependency graph. Nested app
  // node_modules links are redundant with the validated parent dependency tree.
  if (embedded) rmSync(join(distStandaloneRoot, 'node_modules'), { recursive: true, force: true })

  let hoistedCount = 0
  if (!embedded && existsSync(standaloneNodeModulesRoot)) {
    const distNodeModulesRoot = join(distStandaloneRoot, 'node_modules')
    cpSync(standaloneNodeModulesRoot, distNodeModulesRoot, COPY_OPTIONS)
    hoistedCount = hoistPnpmVirtualStore(distNodeModulesRoot)
  }

  if (existsSync(staticRoot)) {
    mkdirSync(join(distStandaloneRoot, distDir), { recursive: true })
    cpSync(staticRoot, join(distStandaloneRoot, distDir, 'static'), COPY_OPTIONS)
  }

  if (existsSync(publicRoot)) {
    cpSync(publicRoot, join(distStandaloneRoot, 'public'), COPY_OPTIONS)
  }

  const hydratedTargets = overlayNodePty(distStandaloneRoot, sourceNodePtyRoot, { sharedDependencies: embedded, distDir })
  writeFileSync(join(distStandaloneRoot, WEB_BUILD_METADATA), JSON.stringify(metadata) + '\n')
  if (!embedded) {
    const priorEmbedded = join(distWebRoot, 'standalone', 'openclaw')
    const priorMetadata = readBuildMetadata(priorEmbedded)
    // Retain an independently built variant only while its shared dependency
    // generation is compatible. The subsequent variant build replaces its app.
    if (priorMetadata?.version === 1 && priorMetadata.basePath === OPENCLAW_WEB_BASE_PATH && priorMetadata.dependencyHash === metadata.dependencyHash) {
      cpSync(priorEmbedded, join(distStandaloneRoot, 'openclaw'), COPY_OPTIONS)
    }
  }

  // Atomic swap: stage fully into .web-staging, then rename into place so a
  // live daemon keeps serving open files from the old inode tree, and the
  // previous generation is preserved as an instant rollback artifact.
  const distWebPrevious = join(root, 'dist', embedded ? '.web-openclaw-previous' : '.web-previous')
  rmSync(distWebPrevious, { recursive: true, force: true })
  if (existsSync(distWebRoot)) renameSync(distWebRoot, distWebPrevious)
  try {
    renameSync(stagingWebRoot, distWebRoot)
  } catch (error) {
    if (existsSync(distWebPrevious) && !existsSync(distWebRoot)) {
      renameSync(distWebPrevious, distWebRoot)
    }
    throw error
  }
  console.log('[gsd] Atomically swapped staged web host into ' + distWebRoot + (existsSync(distWebPrevious) ? ` (previous generation kept at ${distWebPrevious})` : ''))
  if (hoistedCount > 0) {
    console.log(`[gsd] Flattened ${hoistedCount} package(s) from the pnpm virtual store so they survive npm pack.`)
  }
  if (hydratedTargets.length > 0) {
    console.log(`[gsd] Hydrated node-pty native assets in ${hydratedTargets.length} location(s).`)
  }
}

module.exports = {
  COPY_OPTIONS,
  collectStorePackages,
  collectPreferredTopLevelTargets,
  hoistPnpmVirtualStore,
  removeSymlinksRecursively,
  overlayNodePty,
  stageWebStandalone,
  verifyOpenClawDependencies,
  OPENCLAW_WEB_BASE_PATH,
}

if (require.main === module) {
  stageWebStandalone()
}
