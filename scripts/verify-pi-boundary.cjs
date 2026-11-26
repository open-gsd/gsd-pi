#!/usr/bin/env node
'use strict'

const { readFileSync, readdirSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const PI_PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui', 'pi-coding-agent']

const FORBIDDEN_IMPORT = /@gsd\/agent-(core|modes)|@opengsd\//
const FORBIDDEN_PATHS = [
  'src/modes',
  'src/cli',
  'src/main.ts',
  'src/core/agent-session.ts',
  'src/core/sdk.ts',
  'src/core/compaction',
  'src/core/compaction-orchestrator.ts',
  'src/core/bash-executor.ts',
  'src/export-html',
]
const ALLOWLIST = new Set([
  join(ROOT, 'packages/pi-coding-agent/src/core/extension-session-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/keybindings.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/fallback-resolver.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/blob-store.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/artifact-manager.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/lifecycle-hooks.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/system-prompt.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/gsd-seam-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/gsd-extension-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/loader.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/runner.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/retry-handler.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/retry-handler.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/session-manager.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/bash.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/model-resolver.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/package-commands.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/skill-tool.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/skills.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/system-prompt-skill-filter.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/system-prompt-file-safety.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/system-prompt-cache-stability.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/path-display.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/harness.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/utilities.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/bug-report.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/index.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/settings-diagnostics.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/bash.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/edit.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/find.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/grep.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/ls.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/read.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/renderers/write.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/extensions/codemode/renderer.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/extensions/llama/ui.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/extensions/mcp/tools.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/extensions/mcp/ui.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/types/host-shims.d.ts'),
])

function walk(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else if (e.name.endsWith('.ts')) fn(p)
  }
}

const failures = []
for (const pkg of PI_PACKAGES) {
  const src = join(ROOT, 'packages', pkg, 'src')
  walk(src, (file) => {
    if (ALLOWLIST.has(file)) return
    const content = readFileSync(file, 'utf8')
    if (FORBIDDEN_IMPORT.test(content)) {
      failures.push(file.replace(ROOT + '/', ''))
    }
  })
}

if (failures.length) {
  process.stderr.write('Pi boundary violations (GSD imports inside vendored pi packages):\n')
  for (const f of failures) process.stderr.write(`  - ${f}\n`)
  process.exit(1)
}

const pathViolations = []
for (const pkg of PI_PACKAGES) {
  if (pkg !== 'pi-coding-agent') continue
  const pkgRoot = join(ROOT, 'packages', pkg)
  for (const rel of FORBIDDEN_PATHS) {
    const p = join(pkgRoot, rel)
    if (existsSync(p)) pathViolations.push(`packages/${pkg}/${rel}`)
  }
}

if (pathViolations.length) {
  process.stderr.write('Pi seam violations (GSD-owned paths still in pi-coding-agent):\n')
  for (const p of pathViolations) process.stderr.write(`  - ${p}\n`)
  process.exit(1)
}

process.stderr.write('Pi package boundary check passed.\n')
