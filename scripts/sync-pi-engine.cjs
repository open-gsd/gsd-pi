#!/usr/bin/env node
/**
 * sync-pi-engine.cjs — copy a pinned Pi tree onto an external destination and
 * reapply the stored overlay plus the saved package identity.
 *
 * Seam import rewrites stay on scripts/apply-seam.cjs. This command does not
 * invoke that script. On the external coding-agent tree it deletes the
 * post-vendor paths and rewrites the seam import map from pi-seam.json.
 *
 * Usage:
 *   node scripts/sync-pi-engine.cjs --dry-run [--ref <tag>]
 *   node scripts/sync-pi-engine.cjs --dest /absolute/path/outside/this/repo [--ref <tag>]
 *
 * Omit --ref and the command stays on pinnedRef. When .cache/pi-upstream is
 * not the selected tag, --dest clones that tag into a temporary directory.
 * It never writes packages/pi-*.
 */
'use strict'

const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { execFileSync } = require('child_process')
const { tmpdir } = require('os')
const { isAbsolute, join, relative, resolve } = require('path')
const { captureGsdFields, mergeUpstreamPackage, assertCacheAtRef } = require('./vendor-pi.cjs')
const { loadOverlayFiles } = require('./check-pi-overlay-snapshot.cjs')
const { BLOCK_OVERLAY_ON_UNPINNED, applyPi161Ports } = require('./pi-161-ports.cjs')

const ROOT = join(__dirname, '..')

function parseArgs(argv) {
  const opts = { dryRun: false, dest: null, ref: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true
    else if (argv[i] === '--dest' && argv[i + 1]) opts.dest = argv[++i]
    else if (argv[i] === '--ref' && argv[i + 1]) opts.ref = argv[++i]
  }
  return opts
}

function isOutsideRepo(dest) {
  if (!isAbsolute(dest)) return false
  const resolved = resolve(dest)
  const rel = relative(ROOT, resolved)
  return rel.startsWith('..') || isAbsolute(rel)
}

function walkTs(dir, fn) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, fn)
    else if (entry.name.endsWith('.ts')) fn(full)
  }
}

function applySeamImportRewrites(srcRoot, seam) {
  const replacements = [
    ...Object.entries(seam.importRewrites?.agentCore || {}),
    ...Object.entries(seam.importRewrites?.agentModes || {}),
  ]
  const toolFixes = seam.toolComponentImportFixes || [seam.toolComponentImportFix].filter(Boolean)
  walkTs(srcRoot, (file) => {
    let content = readFileSync(file, 'utf8')
    const original = content
    for (const [from, to] of replacements) {
      content = content.replaceAll(`from "${from}"`, `from "${to}"`)
    }
    for (const fix of seam.piInternalPathFixes || []) {
      content = content.replaceAll(`from "${fix.from}`, `from "${fix.to}`)
    }
    for (const { from, to } of toolFixes) {
      content = content.replaceAll(from, to)
    }
    content = content
      .replaceAll('../@gsd/agent-modes/', '@gsd/agent-modes/')
      .replaceAll('../../@gsd/agent-modes/', '@gsd/agent-modes/')
      .replaceAll('../../modes/interactive/theme/theme.js', '../../theme/theme.js')
      .replaceAll('../modes/interactive/theme/theme.js', '../theme/theme.js')
      .replaceAll('../../../modes/interactive/theme/theme.js', '../theme/theme.js')
      .replaceAll('./modes/interactive/theme/theme.js', './theme/theme.js')
      .replace(/modes\/interactive\/theme\//g, 'theme/')
      .replaceAll('from "./modes/interactive/components/index.js"', 'from "@gsd/agent-modes"')
      .replaceAll('from "./modes/index.js"', 'from "@gsd/agent-modes"')
    // Theme files moved from modes/interactive/theme → theme (drop two ../ segments).
    if (file.includes(`${require('path').sep}theme${require('path').sep}`) || file.endsWith(`${require('path').sep}theme.ts`)) {
      for (const fix of seam.themePathFixes || []) {
        content = content.replaceAll(fix.from, fix.to)
      }
    }
    if (content !== original) writeFileSync(file, content)
  })
}

function applyUnpinnedPorts(destRoot) {
  const config = JSON.parse(readFileSync(join(__dirname, 'pi-upstream.json'), 'utf8'))
  applyPi161Ports(destRoot, join(ROOT, config.overlayDir || 'scripts/pi-overlay'), require('fs'), require('path'))
}
function applyPostVendorDeletes(srcRoot, rels) {
  for (const rel of rels) {
    const target = join(srcRoot, rel)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }
}

function selectUpstreamRoot(ref, repository) {
  const override = process.env.GSD_PI_UPSTREAM_ROOT
  if (override) {
    assertCacheAtRef(override, ref)
    return override
  }
  const cache = join(ROOT, '.cache', 'pi-upstream')
  try {
    assertCacheAtRef(cache, ref)
    return cache
  } catch {
    const checkout = mkdtempSync(join(tmpdir(), 'pi-upstream-'))
    execFileSync('git', ['clone', '--depth', '1', '--branch', ref, '--', repository, checkout], { stdio: 'inherit' })
    assertCacheAtRef(checkout, ref)
    return checkout
  }
}

function syncDestination({ upstreamRoot, destRoot, overlayRoot, files, gsdName, savedPackage }) {
  const saved = savedPackage !== undefined
    ? savedPackage
    : (existsSync(join(destRoot, 'package.json'))
      ? JSON.parse(readFileSync(join(destRoot, 'package.json'), 'utf8'))
      : null)
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
  const ref = opts.ref || config.pinnedRef
  const overlayFiles = ref === config.pinnedRef
    ? files
    : files.filter((file) => !BLOCK_OVERLAY_ON_UNPINNED.includes(file))

  if (opts.dryRun) {
    process.stdout.write(`pin ${ref}\n`)
    process.stdout.write(`overlay files ${overlayFiles.length}\n`)
    process.stdout.write('seam scripts/pi-seam.json\n')
    return
  }

  if (!isOutsideRepo(opts.dest)) {
    process.stderr.write('--dest must be an absolute path outside the repo\n')
    process.exit(1)
  }

  const upstreamRoot = selectUpstreamRoot(ref, config.repository)
  const destRoot = resolve(opts.dest)
  const overlayRoot = join(ROOT, config.overlayDir || 'scripts/pi-overlay')
  for (const [upstreamPath, targetPath] of Object.entries(config.packageMap)) {
    const pkgFiles = overlayFiles
      .filter((file) => file === targetPath || file.startsWith(`${targetPath}/`))
      .map((file) => (file === targetPath ? '' : file.slice(targetPath.length + 1)))
      .filter(Boolean)
    const repoPkgPath = join(ROOT, targetPath, 'package.json')
    const savedPackage = existsSync(repoPkgPath)
      ? JSON.parse(readFileSync(repoPkgPath, 'utf8'))
      : null
    syncDestination({
      upstreamRoot: join(upstreamRoot, upstreamPath),
      destRoot: join(destRoot, targetPath),
      overlayRoot: join(overlayRoot, targetPath),
      files: pkgFiles,
      gsdName: config.gsdPackageNames?.[upstreamPath],
      savedPackage,
    })
    if (targetPath === 'packages/pi-coding-agent') {
      const seam = JSON.parse(readFileSync(join(__dirname, 'pi-seam.json'), 'utf8'))
      const srcRoot = join(destRoot, targetPath, 'src')
      const themeUpstream = join(srcRoot, 'modes/interactive/theme')
      const themeDest = join(srcRoot, 'theme')
      // Seam deletes modes/; keep the interactive theme under src/theme for deep imports.
      if (existsSync(themeUpstream)) {
        rmSync(themeDest, { recursive: true, force: true })
        mkdirSync(join(themeDest, '..'), { recursive: true })
        cpSync(themeUpstream, themeDest, { recursive: true })
      }
      applyPostVendorDeletes(srcRoot, seam.postVendorDeletes || [])
      applySeamImportRewrites(srcRoot, seam)
    }
  }
  if (ref !== config.pinnedRef) applyUnpinnedPorts(destRoot)
  process.stderr.write(`Synced ${ref} into ${destRoot}. Repo packages were not modified.\n`)
}

module.exports = {
  syncDestination,
  isOutsideRepo,
  parseArgs,
  selectUpstreamRoot,
  applyPostVendorDeletes,
  applySeamImportRewrites,
}

if (require.main === module) main()
