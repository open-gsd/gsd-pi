#!/usr/bin/env node
'use strict'

const { readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, cpSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')
const { tmpdir } = require('os')

const ROOT = join(__dirname, '..')
const MANIFEST = join(ROOT, 'scripts/pi-upstream.json')
const SEAM = join(ROOT, 'scripts/pi-seam.json')

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

function readAllowlist(manifest) {
  const list = manifest.patchAllowlist
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('scripts/pi-upstream.json must define a non-empty patchAllowlist array')
  }
  return list
}

function git(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function resolveDiffBase() {
  if (process.env.VERIFY_PI_PATCHES_BASE) return process.env.VERIFY_PI_PATCHES_BASE
  const originMain = git(['rev-parse', '--verify', 'origin/main'])
  if (originMain) return originMain
  const main = git(['rev-parse', '--verify', 'main'])
  if (main) return main
  return 'HEAD~1'
}

const PI_PATHSPEC = [
  'packages/pi-agent-core/',
  'packages/pi-ai/',
  'packages/pi-tui/',
  'packages/pi-coding-agent/',
  'packages/pi-schema/',
  'packages/pi-telemetry/',
  'packages/pi-mcp/',
  'packages/pi-codemode/',
]

function isPiSourceOrTest(file) {
  return PI_PATHSPEC.some((prefix) => file.startsWith(prefix)) && /(^|\/)(src|test)\//.test(file)
}

function listChangedPiFiles(base) {
  const names = new Set()
  const includeBranchRange = process.env.VERIFY_PI_PATCHES_BRANCH === '1'

  if (includeBranchRange) {
    for (const prefix of PI_PATHSPEC) {
      const rangeOut = git(['diff', '--name-only', `${base}...HEAD`, '--', prefix])
      for (const file of rangeOut.split('\n').filter(Boolean)) {
        if (isPiSourceOrTest(file)) names.add(file)
      }
    }
  }

  for (const prefix of PI_PATHSPEC) {
    for (const file of git(['diff', '--name-only', '--', prefix]).split('\n').filter(Boolean)) {
      if (isPiSourceOrTest(file)) names.add(file)
    }

    for (const file of git(['diff', '--name-only', '--cached', '--', prefix]).split('\n').filter(Boolean)) {
      if (isPiSourceOrTest(file)) names.add(file)
    }
  }

  return [...names].sort()
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function isAllowlisted(file, allowlist) {
  return allowlist.some((pattern) => {
    if (pattern.includes('*')) {
      return globToRegExp(pattern).test(file)
    }
    return pattern === file
  })
}

const PACKAGE_MAP = {
  'packages/pi-agent-core': 'packages/agent',
  'packages/pi-ai': 'packages/ai',
  'packages/pi-tui': 'packages/tui',
  'packages/pi-coding-agent': 'packages/coding-agent',
  'packages/pi-schema': 'packages/schema',
  'packages/pi-telemetry': 'packages/telemetry',
  'packages/pi-mcp': 'packages/mcp',
  'packages/pi-codemode': 'packages/codemode',
}

let seamConfig = null
function loadSeam() {
  if (seamConfig) return seamConfig
  seamConfig = existsSync(SEAM) ? JSON.parse(readFileSync(SEAM, 'utf8')) : {}
  return seamConfig
}

function normalizePiImportText(content) {
  let c = content
  const renames = [
    ['@earendil-works/pi-agent-core', '@gsd/pi-agent-core'],
    ['@earendil-works/pi-ai', '@gsd/pi-ai'],
    ['@earendil-works/pi-tui', '@gsd/pi-tui'],
    ['@earendil-works/pi-coding-agent', '@gsd/pi-coding-agent'],
    ['@earendil-works/pi-schema', '@gsd/pi-schema'],
    ['@earendil-works/pi-telemetry', '@gsd/pi-telemetry'],
    ['@earendil-works/pi-mcp', '@gsd/pi-mcp'],
    ['@earendil-works/pi-codemode', '@gsd/pi-codemode'],
    ['@mariozechner/pi-agent-core', '@gsd/pi-agent-core'],
    ['@mariozechner/pi-ai', '@gsd/pi-ai'],
    ['@mariozechner/pi-tui', '@gsd/pi-tui'],
    ['@mariozechner/pi-coding-agent', '@gsd/pi-coding-agent'],
  ]
  for (const [from, to] of renames) c = c.replaceAll(from, to)
  c = c.replace(/from "jiti\/static"/g, 'from "@mariozechner/jiti"')
  c = c.replace(/from 'jiti\/static'/g, "from '@mariozechner/jiti'")
  c = c.replace(/from "(\.{1,2}\/[^"]+)\.ts"/g, 'from "$1.js"')
  c = c.replace(/from '(\.{1,2}\/[^']+)\.ts'/g, "from '$1.js'")
  c = c.replace(/import\("(\.{1,2}\/[^"]+)\.ts"\)/g, 'import("$1.js")')
  c = c.replace(/declare module "(\.{1,2}\/[^"]+)\.ts"/g, 'declare module "$1.js"')

  const seam = loadSeam()
  for (const [from, to] of Object.entries(seam.importRewrites?.agentCore || {})) {
    c = c.replaceAll(`from "${from}"`, `from "${to}"`)
  }
  for (const [from, to] of Object.entries(seam.importRewrites?.agentModes || {})) {
    c = c.replaceAll(`from "${from}"`, `from "${to}"`)
  }
  for (const { from, to } of seam.piInternalPathFixes || []) {
    c = c.replaceAll(`from "${from}`, `from "${to}`)
  }
  const pathFixes = [
    ...(seam.toolComponentImportFixes || []),
    ...(seam.themePathFixes || []),
  ]
  if (seam.toolComponentImportFix) pathFixes.push(seam.toolComponentImportFix)
  for (const { from, to } of pathFixes) c = c.replaceAll(from, to)

  // Theme lives under packages/pi-coding-agent/src/theme after ADR-010.
  c = c.replaceAll('../../../modes/interactive/theme/', '../../../theme/')
  c = c.replaceAll('../../modes/interactive/theme/', '../../theme/')
  c = c.replaceAll('../modes/interactive/theme/', '../theme/')

  // GSD-only TypeScript suppressions are not content patches.
  c = c.replace(/^\/\/ @ts-nocheck\n/, '')
  return c
}

function assertCacheAtRef(cacheDir, ref) {
  if (!existsSync(join(cacheDir, '.git')) && !existsSync(join(cacheDir, 'packages'))) {
    throw new Error(`upstream cache missing: ${cacheDir}`)
  }
  const head = git(['rev-parse', 'HEAD'], cacheDir)
  const tag = git(['describe', '--tags', '--exact-match', 'HEAD'], cacheDir)
  if (tag === ref || head === ref) return
  // Accept annotated/lightweight tag name match via rev-parse
  const resolved = git(['rev-parse', `${ref}^{commit}`], cacheDir)
  if (resolved && resolved === head) return
  throw new Error(`upstream cache at ${cacheDir} is ${tag || head}, expected ${ref}`)
}

function ensureUpstreamCache(manifest) {
  const cache = join(ROOT, '.cache', 'pi-upstream')
  const ref = manifest.pinnedRef
  if (!ref) return null
  try {
    assertCacheAtRef(cache, ref)
    return cache
  } catch {
    // fall through to clone
  }

  mkdirSync(join(ROOT, '.cache'), { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'pi-upstream-verify-'))
  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--branch', ref, '--', manifest.repository, staging],
      { stdio: 'pipe', encoding: 'utf8' },
    )
    assertCacheAtRef(staging, ref)
    rmSync(cache, { recursive: true, force: true })
    cpSync(staging, cache, { recursive: true })
    return cache
  } catch (err) {
    process.stderr.write(
      `warning: could not ensure upstream cache at ${ref}: ${err.message || err}\n`,
    )
    return existsSync(cache) ? cache : null
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function matchesPinnedUpstream(file, cache) {
  if (!cache || !existsSync(cache)) return false
  let upstreamRel = null
  for (const [gsd, up] of Object.entries(PACKAGE_MAP)) {
    if (file === gsd || file.startsWith(`${gsd}/`)) {
      upstreamRel = file === gsd ? up : `${up}/${file.slice(gsd.length + 1)}`
      break
    }
  }
  if (!upstreamRel) return false
  const upstreamFile = join(cache, upstreamRel)
  if (!existsSync(upstreamFile)) return false
  const local = normalizePiImportText(readFileSync(join(ROOT, file), 'utf8'))
  const upstream = normalizePiImportText(readFileSync(upstreamFile, 'utf8'))
  return local === upstream
}

function main() {
  if (!existsSync(MANIFEST)) {
    process.stderr.write('Missing scripts/pi-upstream.json\n')
    process.exit(1)
  }

  const manifest = readManifest()
  const allowlist = readAllowlist(manifest)
  const base = resolveDiffBase()
  const includeBranchRange = process.env.VERIFY_PI_PATCHES_BRANCH === '1'
  const cache = ensureUpstreamCache(manifest)
  const changed = listChangedPiFiles(base).filter((file) => existsSync(join(ROOT, file)))
  const undocumented = changed.filter(
    (file) => !isAllowlisted(file, allowlist) && !matchesPinnedUpstream(file, cache),
  )

  if (undocumented.length) {
    process.stderr.write('Undocumented pi-* changes (add to patchAllowlist + pi-upstream.md):\n')
    for (const file of undocumented) process.stderr.write(`  - ${file}\n`)
    process.stderr.write(`\nDiff base: ${base}\n`)
    process.stderr.write('See docs/dev/pi-upstream.md and docs/dev/pi-overlay-execution-plan.md\n')
    process.exit(1)
  }

  process.stderr.write(
    `Pi patch inventory check passed (${changed.length} changed file(s) under packages/pi-*/src|test${includeBranchRange ? ` vs ${base}` : ' in working tree'}).\n`,
  )
}

main()
