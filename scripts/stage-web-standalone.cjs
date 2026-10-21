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
} = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const COPY_OPTIONS = {
  recursive: true,
  force: true,
  dereference: true,
}

function overlayNodePty(targetRoot, sourceNodePtyRoot) {
  if (!existsSync(sourceNodePtyRoot)) return []

  const hydrated = []
  const directTarget = join(targetRoot, 'node_modules', 'node-pty')
  mkdirSync(join(targetRoot, 'node_modules'), { recursive: true })
  cpSync(sourceNodePtyRoot, directTarget, COPY_OPTIONS)
  hydrated.push(directTarget)

  const hashedNodeModulesRoot = join(targetRoot, '.next', 'node_modules')
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

function stageWebStandalone(root = resolve(__dirname, '..')) {
  const webRoot = join(root, 'web')
  const standaloneRoot = join(webRoot, '.next', 'standalone')
  const standaloneAppRoot = join(standaloneRoot, 'web')
  const standaloneNodeModulesRoot = join(standaloneRoot, 'node_modules')
  const staticRoot = join(webRoot, '.next', 'static')
  const publicRoot = join(webRoot, 'public')
  const distWebRoot = join(root, 'dist', 'web')
  const stagingWebRoot = join(root, 'dist', '.web-staging')
  const distStandaloneRoot = join(stagingWebRoot, 'standalone')
  const sourceNodePtyRoot = join(webRoot, 'node_modules', 'node-pty')

  if (!existsSync(standaloneAppRoot)) {
    console.error('[gsd] Web standalone build not found at web/.next/standalone/web. Run `npm --prefix web run build` first.')
    process.exit(1)
  }

  rmSync(stagingWebRoot, { recursive: true, force: true })
  mkdirSync(distStandaloneRoot, { recursive: true })

  cpSync(standaloneAppRoot, distStandaloneRoot, COPY_OPTIONS)

  let hoistedCount = 0
  if (existsSync(standaloneNodeModulesRoot)) {
    const distNodeModulesRoot = join(distStandaloneRoot, 'node_modules')
    cpSync(standaloneNodeModulesRoot, distNodeModulesRoot, COPY_OPTIONS)
    hoistedCount = hoistPnpmVirtualStore(distNodeModulesRoot)
  }

  if (existsSync(staticRoot)) {
    mkdirSync(join(distStandaloneRoot, '.next'), { recursive: true })
    cpSync(staticRoot, join(distStandaloneRoot, '.next', 'static'), COPY_OPTIONS)
  }

  if (existsSync(publicRoot)) {
    cpSync(publicRoot, join(distStandaloneRoot, 'public'), COPY_OPTIONS)
  }

  const hydratedTargets = overlayNodePty(distStandaloneRoot, sourceNodePtyRoot)

  // Atomic swap: stage fully into .web-staging, then rename into place so a
  // live daemon keeps serving open files from the old inode tree, and the
  // previous generation is preserved as an instant rollback artifact.
  const distWebPrevious = join(root, 'dist', '.web-previous')
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
  console.log('[gsd] Atomically swapped staged web host into ' + distWebRoot + (existsSync(distWebPrevious) ? ' (previous generation kept at dist/.web-previous)' : ''))
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
}

if (require.main === module) {
  stageWebStandalone()
}
