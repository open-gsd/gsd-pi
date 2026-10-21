#!/usr/bin/env node
/**
 * ensure-workspace-builds.cjs
 *
 * Checks whether workspace packages have been compiled (dist/ exists with
 * index.js) and that the build is not stale (no src/ file newer than dist/).
 * If any are missing or stale, runs the build for those packages.
 *
 * Invoked by the dev-CLI preflight (scripts/dev-cli-helpers.mjs) so that running
 * the local CLI in a fresh clone produces a working runtime without a manual
 * `pnpm run build` step. Also catches the common case where `git pull` updates
 * package sources but the old dist/ remains, causing TypeScript type errors.
 *
 * NOTE: this is a development-only helper — it is NOT run by the npm postinstall
 * hook. It self-skips in CI (the full build pipeline handles builds) and when
 * installed as an end-user dependency (no packages/ directory), so it is not
 * shipped in the published tarball's "files" list.
 */
const { existsSync, statSync, readdirSync } = require('fs')
const { resolve, join } = require('path')
const { execSync } = require('child_process')

/**
 * Returns the most recent mtime (ms) of any .ts file under dir, recursively.
 * Returns 0 if no .ts files found.
 */
function newestSrcMtime(dir) {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSrcMtime(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

/**
 * Detects workspace packages whose dist/ is missing or stale.
 *
 * Missing dist/index.js is always reported (the package won't work at all).
 *
 * Staleness (src/ newer than dist/) is ONLY checked when a .git directory
 * exists at root — indicating a development clone. In npm tarball installs,
 * file timestamps are unreliable (npm sets all files to a canonical date,
 * but extraction ordering can cause src/ to appear 1-2 seconds newer than
 * dist/). Attempting to rebuild in that scenario is dangerous: devDependencies
 * (including TypeScript) are not installed, and any globally-installed tsc
 * may produce broken output that overwrites the known-good dist/.
 *
 * @param {string} root    Project root directory
 * @param {string[]} packages  Package directory names to check
 * @returns {string[]} Package names that need rebuilding
 */
function detectStalePackages(root, packages) {
  const packagesDir = join(root, 'packages')
  const isDevClone = existsSync(join(root, '.git'))

  const stale = []
  for (const pkg of packages) {
    const distIndex = join(packagesDir, pkg, 'dist', 'index.js')
    if (!existsSync(distIndex)) {
      stale.push(pkg)
      continue
    }
    // Only check src vs dist timestamps in development clones.
    // In npm tarball installs, timestamps are unreliable and rebuilding
    // without devDependencies can corrupt the pre-built dist/ (#2877).
    if (isDevClone) {
      const distMtime = statSync(distIndex).mtimeMs
      const srcMtime = newestSrcMtime(join(packagesDir, pkg, 'src'))
      if (srcMtime > distMtime) {
        stale.push(pkg)
      }
    }
  }
  return stale
}

if (require.main === module) {
  const root = resolve(__dirname, '..')
  const packagesDir = join(root, 'packages')

  // Skip if packages/ doesn't exist (published tarball / end-user install)
  if (!existsSync(packagesDir)) process.exit(0)

  // Skip in CI — the pipeline runs `pnpm run build` explicitly
  if (process.env.CI === 'true' || process.env.CI === '1') process.exit(0)

  // Workspace packages that need dist/index.js at runtime.
  // Order matters: dependencies must build before dependents — `contracts` is the
  // lowest-level package and must be first, or dependents compile against a stale
  // dist/. This list is topologically ordered, so it can't be auto-derived from
  // the alphabetically-sorted getLinkablePackages(); the drift guard below keeps
  // it complete instead.
  const WORKSPACE_PACKAGES = [
    'contracts',
    'native',
    'pi-tui',
    'pi-ai',
    'pi-agent-core',
    'pi-coding-agent',
    'gsd-agent-core',
    'gsd-agent-modes',
    'rpc-client',
    'mcp-server',
  ]

  // Drift guard: every linkable package must appear above, or a fresh clone
  // would silently run against a stale/missing dist for the omitted package.
  try {
    const { getLinkablePackages } = require('./lib/workspace-manifest.cjs')
    const missing = getLinkablePackages()
      .map((p) => p.dir)
      .filter((dir) => !WORKSPACE_PACKAGES.includes(dir))
    if (missing.length > 0) {
      process.stderr.write(
        `  WARNING: linkable package(s) missing from ensure-workspace-builds order: ${missing.join(', ')}\n` +
        `  Add them in topological (dependency-first) order to WORKSPACE_PACKAGES.\n`,
      )
    }
  } catch {
    // workspace-manifest is dev-only; ignore if unavailable.
  }

  const stale = detectStalePackages(root, WORKSPACE_PACKAGES)

  if (stale.length === 0) process.exit(0)

  process.stderr.write(`  Building ${stale.length} workspace package(s) with stale or missing dist/: ${stale.join(', ')}\n`)

  for (const pkg of stale) {
    const pkgDir = join(packagesDir, pkg)
    const distIndex = join(pkgDir, 'dist', 'index.js')
    try {
      // execSync is safe here: the command is a hardcoded string, not user input
      execSync('pnpm run build', { cwd: pkgDir, stdio: 'pipe' })
      if (!existsSync(distIndex)) {
        throw new Error('build finished but dist/index.js is missing (stale TypeScript incremental cache?)')
      }
      process.stderr.write(`  ✓ ${pkg}\n`)
    } catch (err) {
      process.stderr.write(`  ✗ ${pkg} build failed: ${err.message}\n`)
      // Non-fatal — the user can run `pnpm run build` manually
    }
  }
}

module.exports = { newestSrcMtime, detectStalePackages }
