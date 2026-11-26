#!/usr/bin/env node
'use strict'

const { readFileSync, existsSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const ROOT = join(__dirname, '..')
const MANIFEST = join(ROOT, 'scripts/pi-upstream.json')

function readAllowlist() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const list = manifest.patchAllowlist
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('scripts/pi-upstream.json must define a non-empty patchAllowlist array')
  }
  return list
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
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

function normalizePiImportText(content) {
  let c = content
  c = c.replaceAll('@earendil-works/pi-agent-core', '@gsd/pi-agent-core')
  c = c.replaceAll('@earendil-works/pi-ai', '@gsd/pi-ai')
  c = c.replaceAll('@earendil-works/pi-tui', '@gsd/pi-tui')
  c = c.replaceAll('@earendil-works/pi-coding-agent', '@gsd/pi-coding-agent')
  c = c.replaceAll('@mariozechner/pi-agent-core', '@gsd/pi-agent-core')
  c = c.replaceAll('@mariozechner/pi-ai', '@gsd/pi-ai')
  c = c.replaceAll('@mariozechner/pi-tui', '@gsd/pi-tui')
  c = c.replaceAll('@mariozechner/pi-coding-agent', '@gsd/pi-coding-agent')
  c = c.replace(/from "jiti\/static"/g, 'from "@mariozechner/jiti"')
  c = c.replace(/from 'jiti\/static'/g, "from '@mariozechner/jiti'")
  c = c.replace(/from "(\.{1,2}\/[^"]+)\.ts"/g, 'from "$1.js"')
  c = c.replace(/from '(\.{1,2}\/[^']+)\.ts'/g, "from '$1.js'")
  c = c.replace(/import\("(\.{1,2}\/[^"]+)\.ts"\)/g, 'import("$1.js")')
  c = c.replace(/declare module "(\.{1,2}\/[^"]+)\.ts"/g, 'declare module "$1.js"')
  return c
}

function matchesPinnedUpstream(file) {
  const cache = join(ROOT, '.cache', 'pi-upstream')
  if (!existsSync(cache)) return false
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

  const allowlist = readAllowlist()
  const base = resolveDiffBase()
  const includeBranchRange = process.env.VERIFY_PI_PATCHES_BRANCH === '1'
  const changed = listChangedPiFiles(base).filter((file) => existsSync(join(ROOT, file)))
  const undocumented = changed.filter(
    (file) => !isAllowlisted(file, allowlist) && !matchesPinnedUpstream(file),
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
