#!/usr/bin/env node
/** vendor-pi-coding-agent-core.cjs — sync pi-coding-agent core/utils from upstream v0.75.5. */
'use strict'

const { cpSync, existsSync, readFileSync, writeFileSync, rmSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')
const { assertCacheAtRef } = require('./vendor-pi.cjs')

const ROOT = join(__dirname, '..')
const UP = join(ROOT, '.cache/pi-upstream/packages/coding-agent/src')
const CORE = join(ROOT, 'packages/pi-coding-agent/src/core')
const UTILS = join(ROOT, 'packages/pi-coding-agent/src/utils')

const PROTECTED = new Set([
  'keybindings.ts',
  'fallback-resolver.ts',
  'lifecycle-hooks.ts',
  'blob-store.ts',
  'artifact-manager.ts',
  'system-prompt.ts',
  'model-discovery.ts',
  'models-json-writer.ts',
  'package-commands.ts',
  'db-snapshot.ts',
  'capability-patches.ts',
  'gsd-seam-types.ts',
  'gsd-extension-types.ts',
  'session-cwd.ts',
  'extension-session-types.ts',
  'extensions/types.ts',
  'extensions/extension-upstream-types.ts',
])

function backupProtected() {
  const out = {}
  for (const f of PROTECTED) {
    const p = join(CORE, f)
    if (existsSync(p)) out[f] = readFileSync(p, 'utf8')
  }
  return out
}

function restoreProtected(backups) {
  for (const [f, content] of Object.entries(backups)) {
    writeFileSync(join(CORE, f), content)
  }
}

function parseArgs(argv) {
  const opts = { ref: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref' && argv[i + 1]) opts.ref = argv[++i]
  }
  return opts
}

function main() {
  const config = JSON.parse(readFileSync(join(__dirname, 'pi-upstream.json'), 'utf8'))
  const ref = parseArgs(process.argv.slice(2)).ref || config.pinnedRef
  if (!ref) {
    throw new Error('No upstream ref. Set pinnedRef in scripts/pi-upstream.json or pass --ref')
  }
  assertCacheAtRef(join(ROOT, '.cache/pi-upstream'), ref)

  const backups = backupProtected()
  rmSync(CORE, { recursive: true, force: true })
  cpSync(join(UP, 'core'), CORE, { recursive: true })
  rmSync(UTILS, { recursive: true, force: true })
  cpSync(join(UP, 'utils'), UTILS, { recursive: true })

  restoreProtected(backups)

  for (const f of [
    'agent-session.ts',
    'agent-session-services.ts',
    'agent-session-runtime.ts',
    'sdk.ts',
    'compaction-orchestrator.ts',
    'contextual-tips.ts',
    'image-overflow-recovery.ts',
  ]) {
    const p = join(CORE, f)
    if (existsSync(p)) rmSync(p)
  }
  const compactionDir = join(CORE, 'compaction')
  const exportHtmlDir = join(CORE, 'export-html')
  if (existsSync(compactionDir)) rmSync(compactionDir, { recursive: true })
  if (existsSync(exportHtmlDir)) rmSync(exportHtmlDir, { recursive: true })

  execSync('node scripts/normalize-pi-imports.cjs', { cwd: ROOT, stdio: 'inherit' })
  execSync('node scripts/apply-seam.cjs --imports-only', { cwd: ROOT, stdio: 'inherit' })
  execSync('node scripts/generate-pi-coding-agent-index.cjs', { cwd: ROOT, stdio: 'inherit' })

  process.stderr.write('vendor-pi-coding-agent-core: done\n')
}

if (require.main === module) {
  main()
}
