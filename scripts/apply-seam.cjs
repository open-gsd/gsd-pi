#!/usr/bin/env node
/**
 * Idempotent post-vendor seam application (ADR-010).
 * Replaces the scattered fix-*-imports chain with a single config-driven step.
 *
 * Usage:
 *   node scripts/apply-seam.cjs              # full seam (deletes + imports + verify)
 *   node scripts/apply-seam.cjs --imports-only  # import/path fixes only (vendor core step)
 *   node scripts/apply-seam.cjs --skip-verify   # full seam without boundary check
 */
'use strict'

const { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const ROOT = join(__dirname, '..')
const CONFIG = JSON.parse(readFileSync(join(__dirname, 'pi-seam.json'), 'utf8'))
const PI = join(ROOT, 'packages/pi-coding-agent')
const PI_SRC = join(PI, 'src')

const args = new Set(process.argv.slice(2))
const importsOnly = args.has('--imports-only')
const skipVerify = args.has('--skip-verify') || importsOnly

function walk(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else if (e.name.endsWith('.ts')) fn(p)
  }
}

function del(rel) {
  const p = join(PI_SRC, rel)
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true })
    console.log('removed', rel)
  }
}

function applyImportRewrites(content) {
  let c = content
  for (const [from, to] of Object.entries(CONFIG.importRewrites.agentCore)) {
    c = c.replaceAll(`from "${from}"`, `from "${to}"`)
  }
  for (const [from, to] of Object.entries(CONFIG.importRewrites.agentModes)) {
    c = c.replaceAll(`from "${from}"`, `from "${to}"`)
  }
  for (const { from, to } of CONFIG.piInternalPathFixes) {
    c = c.replaceAll(`from "${from}`, `from "${to}`)
  }
  c = c.replace(/from "(\.\.\/)+pi-coding-agent\/src\/([^"]+)"/g, 'from "@gsd/pi-coding-agent/$2"')
  c = c.replace(/core\/extensionstypes\.js/g, 'core/extensions/types.js')
  c = c.replace(/core\/toolstool-compatibility-registry\.js/g, 'core/tools/tool-compatibility-registry.js')
  c = c.replace(/core\/toolstruncate\.js/g, 'core/tools/truncate.js')
  c = c.replace(/themetheme\.js/g, 'theme/theme.js')
  c = c.replace(/extensionsindex\.js/g, 'extensions/index.js')
  return c
}

function localPathForSymbol(file, localPath) {
  if (file.startsWith(join(PI_SRC, 'core/extensions')) || file.startsWith(join(PI_SRC, 'core/tools'))) {
    return localPath.replace('./', '../')
  }
  return localPath
}

function applyLocalPiShimImports(file, content) {
  let c = content
  for (const [symbol, localPath] of Object.entries(CONFIG.localPiShimImports)) {
    const rel = localPathForSymbol(file, localPath)
    c = c.replace(
      new RegExp(`import\\s*\\{([^}]*\\b${symbol}\\b[^}]*)\\}\\s*from\\s*"@gsd/agent-core"`, 'g'),
      (_m, inner) => `import {${inner}} from "${rel}"`,
    )
    c = c.replace(
      new RegExp(`import\\s*type\\s*\\{([^}]*\\b${symbol}\\b[^}]*)\\}\\s*from\\s*"@gsd/agent-core"`, 'g'),
      (_m, inner) => `import type {${inner}} from "${rel}"`,
    )
    c = c.replace(
      new RegExp(`export\\s*type\\s*\\{([^}]*\\b${symbol}\\b[^}]*)\\}\\s*from\\s*"@gsd/agent-core"`, 'g'),
      (_m, inner) => `export type {${inner}} from "${rel}"`,
    )
  }
  return c
}

function applyPiInternalPathFixes(content) {
  let c = content
  for (const { from, to } of CONFIG.piInternalPathFixes) {
    c = c.replaceAll(`from "${from}`, `from "${to}`)
  }
  c = c.replace(/from "(\.\.\/)+pi-coding-agent\/src\/([^"]+)"/g, 'from "@gsd/pi-coding-agent/$2"')
  return c
}

function applyThemePathFixes() {
  const themeDir = join(PI_SRC, 'theme')
  if (!existsSync(themeDir)) return

  walk(themeDir, (file) => {
    let c = readFileSync(file, 'utf8')
    const orig = c
    for (const { from, to } of CONFIG.themePathFixes) {
      c = c.replaceAll(from, to)
    }
    if (c !== orig) writeFileSync(file, c)
  })
}

function applyToolComponentImportFixes() {
  const fixes = CONFIG.toolComponentImportFixes || [CONFIG.toolComponentImportFix].filter(Boolean)
  walk(PI_SRC, (file) => {
    let c = readFileSync(file, 'utf8')
    const orig = c
    for (const { from, to } of fixes) {
      c = c.replaceAll(from, to)
    }
    // Normalize package imports that incorrectly kept a relative prefix.
    c = c.replaceAll('../@gsd/agent-modes/', '@gsd/agent-modes/')
    c = c.replaceAll('../../@gsd/agent-modes/', '@gsd/agent-modes/')
    if (c !== orig) writeFileSync(file, c)
  })
}

function applyCoreThemeImportFixes() {
  walk(PI_SRC, (file) => {
    let c = readFileSync(file, 'utf8')
    const n = c
      .replaceAll('../../modes/interactive/theme/theme.js', '../../theme/theme.js')
      .replaceAll('../modes/interactive/theme/theme.js', '../theme/theme.js')
      .replaceAll('../../../modes/interactive/theme/theme.js', '../theme/theme.js')
      .replaceAll('./modes/interactive/theme/theme.js', './theme/theme.js')
      .replace(/modes\/interactive\/theme\//g, 'theme/')
      .replaceAll('from "./modes/interactive/components/index.js"', 'from "@gsd/agent-modes"')
      .replaceAll('from "./modes/index.js"', 'from "@gsd/agent-modes"')
    if (n !== c) writeFileSync(file, n)
  })
}

function applyImportFixes() {
  walk(PI_SRC, (file) => {
    const orig = readFileSync(file, 'utf8')
    let fixed = applyPiInternalPathFixes(orig)
    fixed = applyLocalPiShimImports(file, fixed)
    if (fixed !== orig) writeFileSync(file, fixed)
  })

  for (const pkg of ['gsd-agent-modes']) {
    walk(join(ROOT, 'packages', pkg, 'src'), (file) => {
      const orig = readFileSync(file, 'utf8')
      const fixed = applyImportRewrites(orig)
      if (fixed !== orig) writeFileSync(file, fixed)
    })
  }

  applyToolComponentImportFixes()
  applyThemePathFixes()
  applyCoreThemeImportFixes()
}

function applyPostVendorDeletes() {
  const themeSrc = join(PI_SRC, 'modes/interactive/theme')
  const themeDest = join(PI_SRC, 'theme')
  if (existsSync(themeSrc)) {
    if (existsSync(themeDest)) rmSync(themeDest, { recursive: true, force: true })
    renameSync(themeSrc, themeDest)
    console.log('moved theme to src/theme')
  }

  for (const rel of CONFIG.postVendorDeletes) {
    del(rel)
  }
}

if (!importsOnly) {
  applyPostVendorDeletes()
}

applyImportFixes()

if (!importsOnly && existsSync(join(__dirname, 'trim-pi-coding-agent-index.cjs'))) {
  execSync('node scripts/trim-pi-coding-agent-index.cjs', { cwd: ROOT, stdio: 'inherit' })
}

if (!skipVerify) {
  execSync('node scripts/verify-pi-boundary.cjs', { cwd: ROOT, stdio: 'inherit' })
}

process.stderr.write(`apply-seam: done${importsOnly ? ' (imports only)' : ''}\n`)
