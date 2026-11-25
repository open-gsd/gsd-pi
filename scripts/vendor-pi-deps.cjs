#!/usr/bin/env node
/**
 * vendor-pi-deps.cjs — vendor pi-agent-core, pi-ai, pi-tui only (not pi-coding-agent).
 * Keeps ADR-010 seamed pi-coding-agent intact.
 */
'use strict'

const { existsSync, readFileSync, writeFileSync, rmSync, cpSync } = require('fs')
const { join, resolve } = require('path')
const { execSync } = require('child_process')
const { assertCacheAtRef, captureGsdFields, mergeUpstreamPackage } = require('./vendor-pi.cjs')

const REPO_ROOT = resolve(__dirname, '..')
const CACHE_DIR = join(REPO_ROOT, '.cache', 'pi-upstream')

const PACKAGES = [
  ['packages/agent', 'packages/pi-agent-core', '@gsd/pi-agent-core'],
  ['packages/ai', 'packages/pi-ai', '@gsd/pi-ai'],
  ['packages/tui', 'packages/pi-tui', '@gsd/pi-tui'],
]

function parseArgs(argv) {
  const opts = { ref: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref' && argv[i + 1]) opts.ref = argv[++i]
  }
  return opts
}

function readPackageJson(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  return JSON.parse(readFileSync(pkgPath, 'utf8'))
}

function main() {
  const config = JSON.parse(readFileSync(join(__dirname, 'pi-upstream.json'), 'utf8'))
  const ref = parseArgs(process.argv.slice(2)).ref || config.pinnedRef
  if (!ref) {
    throw new Error('No upstream ref. Set pinnedRef in scripts/pi-upstream.json or pass --ref')
  }
  assertCacheAtRef(CACHE_DIR, ref)

  for (const [upstreamSubdir, targetSubdir, gsdName] of PACKAGES) {
    const src = join(CACHE_DIR, upstreamSubdir)
    const dest = join(REPO_ROOT, targetSubdir)
    if (!existsSync(src)) {
      throw new Error(`Missing upstream package: ${src}`)
    }
    process.stderr.write(`Copy ${upstreamSubdir} → ${targetSubdir}\n`)
    const savedFields = captureGsdFields(readPackageJson(dest))
    rmSync(dest, { recursive: true, force: true })
    cpSync(src, dest, { recursive: true })
    const upstreamPkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    const merged = mergeUpstreamPackage(upstreamPkg, savedFields, gsdName)
    writeFileSync(join(dest, 'package.json'), JSON.stringify(merged, null, 2) + '\n')
  }

  execSync('node scripts/normalize-pi-imports.cjs', { cwd: REPO_ROOT, stdio: 'inherit' })
  execSync('node scripts/apply-gsd-pi-package-json.cjs', { cwd: REPO_ROOT, stdio: 'inherit' })
  execSync('node scripts/restore-pi-tsconfig.cjs', { cwd: REPO_ROOT, stdio: 'inherit' })
  process.stderr.write('vendor-pi-deps: done\n')
}

if (require.main === module) {
  main()
}
