#!/usr/bin/env node
/**
 * sync-pi-engine.cjs — copy a pinned Pi tree onto an external destination and
 * reapply the stored overlay plus the saved package identity.
 *
 * Seam deletes and import rewrites stay on scripts/apply-seam.cjs. This
 * command does not invoke apply-seam.cjs or apply-gsd-pi-package-json.cjs.
 *
 * Usage:
 *   node scripts/sync-pi-engine.cjs --dry-run
 *   node scripts/sync-pi-engine.cjs --dest /absolute/path/outside/this/repo
 */
'use strict'

const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { isAbsolute, join, relative, resolve, sep } = require('path')
const { captureGsdFields, mergeUpstreamPackage, assertCacheAtRef } = require('./vendor-pi.cjs')
const { loadOverlayFiles } = require('./check-pi-overlay-snapshot.cjs')

const ROOT = join(__dirname, '..')

function parseArgs(argv) {
  const opts = { dryRun: false, dest: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true
    else if (argv[i] === '--dest' && argv[i + 1]) opts.dest = argv[++i]
  }
  return opts
}

function isOutsideRepo(dest) {
  if (!isAbsolute(dest)) return false
  const resolved = resolve(dest)
  const rel = relative(ROOT, resolved)
  return rel.startsWith('..') || isAbsolute(rel)
}

function syncDestination({ upstreamRoot, destRoot, overlayRoot, files, gsdName }) {
  const saved = existsSync(join(destRoot, 'package.json'))
    ? JSON.parse(readFileSync(join(destRoot, 'package.json'), 'utf8'))
    : null
  rmSync(destRoot, { recursive: true, force: true })
  mkdirSync(destRoot, { recursive: true })
  cpSync(upstreamRoot, destRoot, { recursive: true })
  if (existsSync(join(destRoot, 'package.json'))) {
    const upstreamPkg = JSON.parse(readFileSync(join(destRoot, 'package.json'), 'utf8'))
    const merged = mergeUpstreamPackage(upstreamPkg, captureGsdFields(saved), gsdName || saved?.name)
    writeFileSync(join(destRoot, 'package.json'), `${JSON.stringify(merged, null, 2)}\n`)
  }
  for (const file of files) {
    const from = join(overlayRoot, file)
    const to = join(destRoot, file)
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(from, to)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.dryRun && !opts.dest) {
    process.stderr.write('Refusing to sync in-repo. Pass --dry-run or --dest <absolute path outside the repo>.\n')
    process.exit(1)
  }

  const config = JSON.parse(readFileSync(join(__dirname, 'pi-upstream.json'), 'utf8'))
  const { files } = loadOverlayFiles(ROOT)

  if (opts.dryRun) {
    process.stdout.write(`pin ${config.pinnedRef}\n`)
    process.stdout.write(`overlay files ${files.length}\n`)
    process.stdout.write('seam scripts/pi-seam.json\n')
    return
  }

  if (!isOutsideRepo(opts.dest)) {
    process.stderr.write('--dest must be an absolute path outside the repo\n')
    process.exit(1)
  }

  const ref = config.pinnedRef
  assertCacheAtRef(join(ROOT, '.cache', 'pi-upstream'), ref)
  const destRoot = resolve(opts.dest)
  const overlayRoot = join(ROOT, config.overlayDir || 'scripts/pi-overlay')
  for (const [upstreamPath, targetPath] of Object.entries(config.packageMap)) {
    const pkgFiles = files
      .filter((file) => file === targetPath || file.startsWith(`${targetPath}/`))
      .map((file) => (file === targetPath ? '' : file.slice(targetPath.length + 1)))
      .filter(Boolean)
    syncDestination({
      upstreamRoot: join(ROOT, '.cache', 'pi-upstream', upstreamPath),
      destRoot: join(destRoot, targetPath),
      overlayRoot: join(overlayRoot, targetPath),
      files: pkgFiles,
      gsdName: config.gsdPackageNames?.[upstreamPath],
    })
  }
  process.stderr.write(`Synced ${ref} into ${destRoot}. Seam scripts were not run.\n`)
}

module.exports = { syncDestination, isOutsideRepo, parseArgs }

if (require.main === module) main()
