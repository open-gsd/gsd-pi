#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync, readdirSync, statSync } = require('fs')
const { join, relative, dirname } = require('path')

const ROOT = join(__dirname, '..')

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function walk(dir, fn) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, fn)
    else fn(full)
  }
}

function expandPattern(root, pattern) {
  if (!pattern.includes('*')) return [pattern]
  const regex = globToRegExp(pattern)
  const slash = pattern.indexOf('*')
  const prefix = pattern.slice(0, slash)
  const startDir = prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix)
  const found = []
  walk(join(root, startDir), (full) => {
    const rel = relative(root, full).replaceAll('\\', '/')
    if (regex.test(rel) && statSync(full).isFile()) found.push(rel)
  })
  return found.sort()
}

function loadOverlayFiles(root) {
  const config = JSON.parse(readFileSync(join(root, 'scripts/pi-upstream.json'), 'utf8'))
  const seam = JSON.parse(readFileSync(join(root, 'scripts/pi-seam.json'), 'utf8'))
  const files = new Set()
  const errors = []
  for (const pattern of config.patchAllowlist || []) {
    const matches = expandPattern(root, pattern)
    if (matches.length === 0) {
      errors.push(`allowlist pattern matched no files: ${pattern}`)
      continue
    }
    for (const file of matches) {
      if (!pattern.includes('*') && !existsSync(join(root, file))) {
        errors.push(`missing source ${file}`)
        continue
      }
      files.add(file)
    }
  }
  for (const rel of seam.protectedPiCoreFiles || []) {
    const file = `packages/pi-coding-agent/src/core/${rel}`
    if (!existsSync(join(root, file))) {
      errors.push(`missing protected source ${file}`)
      continue
    }
    files.add(file)
  }
  return { files: [...files].sort(), errors, overlayDir: config.overlayDir || 'scripts/pi-overlay' }
}

function compareSnapshots(root, files, overlayDir) {
  const errors = []
  for (const file of files) {
    const source = join(root, file)
    const snapshot = join(root, overlayDir, file)
    if (!existsSync(source)) {
      errors.push(`missing source ${file}`)
      continue
    }
    if (!existsSync(snapshot)) {
      errors.push(`missing snapshot ${file}`)
      continue
    }
    const left = readFileSync(source)
    const right = readFileSync(snapshot)
    if (!left.equals(right)) errors.push(`snapshot bytes differ ${file}`)
  }
  return errors
}

function main() {
  const { files, errors, overlayDir } = loadOverlayFiles(ROOT)
  const compared = compareSnapshots(ROOT, files, overlayDir)
  const all = [...errors, ...compared]
  if (all.length) {
    for (const error of all) process.stderr.write(`${error}\n`)
    process.exit(1)
  }
  process.stderr.write(`Pi overlay snapshot matches ${files.length} file(s).\n`)
}

module.exports = { compareSnapshots, expandPattern, loadOverlayFiles }

if (require.main === module) main()
