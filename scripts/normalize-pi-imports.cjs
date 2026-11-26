#!/usr/bin/env node
/**
 * normalize-pi-imports.cjs — rewrite upstream v0.75.5 imports for GSD tsc (Node16 + @gsd/*).
 */
'use strict'

const { readFileSync, writeFileSync, readdirSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui', 'pi-coding-agent', 'pi-schema', 'pi-telemetry', 'pi-mcp', 'pi-codemode']

function walk(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else if (e.name.endsWith('.ts')) fn(p)
  }
}

function normalize(content) {
  let c = content
  c = c.replaceAll('@earendil-works/pi-agent-core', '@gsd/pi-agent-core')
  c = c.replaceAll('@earendil-works/pi-ai', '@gsd/pi-ai')
  c = c.replaceAll('@earendil-works/pi-tui', '@gsd/pi-tui')
  c = c.replaceAll('@earendil-works/pi-coding-agent', '@gsd/pi-coding-agent')
  c = c.replaceAll('@earendil-works/pi-schema', '@gsd/pi-schema')
  c = c.replaceAll('@earendil-works/pi-telemetry', '@gsd/pi-telemetry')
  c = c.replaceAll('@earendil-works/pi-mcp', '@gsd/pi-mcp')
  c = c.replaceAll('@earendil-works/pi-codemode', '@gsd/pi-codemode')
  c = c.replaceAll('@mariozechner/pi-agent-core', '@gsd/pi-agent-core')
  c = c.replaceAll('@mariozechner/pi-ai', '@gsd/pi-ai')
  c = c.replaceAll('@mariozechner/pi-tui', '@gsd/pi-tui')
  c = c.replaceAll('@mariozechner/pi-coding-agent', '@gsd/pi-coding-agent')
  c = c.replaceAll('@mariozechner/pi-schema', '@gsd/pi-schema')
  c = c.replaceAll('@mariozechner/pi-telemetry', '@gsd/pi-telemetry')
  c = c.replaceAll('@mariozechner/pi-mcp', '@gsd/pi-mcp')
  c = c.replaceAll('@mariozechner/pi-codemode', '@gsd/pi-codemode')
  // Upstream v0.75.5 uses the unscoped `typebox` package; keep as-is.
  c = c.replace(/from "jiti\/static"/g, 'from "@mariozechner/jiti"')
  c = c.replace(/from 'jiti\/static'/g, "from '@mariozechner/jiti'")
  // Node16: relative imports use .js, not .ts
  c = c.replace(/from "(\.{1,2}\/[^"]+)\.ts"/g, 'from "$1.js"')
  c = c.replace(/from '(\.{1,2}\/[^']+)\.ts'/g, "from '$1.js'")
  c = c.replace(/import\("(\.{1,2}\/[^"]+)\.ts"\)/g, 'import("$1.js")')
  c = c.replace(/declare module "(\.{1,2}\/[^"]+)\.ts"/g, 'declare module "$1.js"')
  return c
}

let changed = 0
for (const pkg of PACKAGES) {
  for (const sub of ['src', 'test']) {
    const src = join(ROOT, 'packages', pkg, sub)
    if (!existsSync(src)) continue
    walk(src, (file) => {
      const orig = readFileSync(file, 'utf8')
      const next = normalize(orig)
      if (next !== orig) {
        writeFileSync(file, next)
        changed++
      }
    })
  }
}

process.stderr.write(`normalize-pi-imports: updated ${changed} files\n`)
