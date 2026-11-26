#!/usr/bin/env node
'use strict'

const { readFileSync } = require('fs')
const { join } = require('path')
const { loadOverlayFiles } = require('./check-pi-overlay-snapshot.cjs')

const ROOT = join(__dirname, '..')
const DOC = join(ROOT, 'docs/dev/pi-overlay-triage.md')

function documentedPaths(markdown) {
  const paths = new Set()
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|/)
    if (match) paths.add(match[1])
  }
  return paths
}

function missingTriagePaths(required, markdown) {
  const documented = documentedPaths(markdown)
  return required.filter((file) => !documented.has(file))
}

function main() {
  const { files } = loadOverlayFiles(ROOT)
  const missing = missingTriagePaths(files, readFileSync(DOC, 'utf8'))
  if (missing.length) {
    process.stderr.write('Pi overlay triage is missing paths:\n')
    for (const file of missing) process.stderr.write(`  ${file}\n`)
    process.exit(1)
  }
  process.stderr.write(`Pi overlay triage covers ${files.length} file(s).\n`)
}

module.exports = { documentedPaths, missingTriagePaths }

if (require.main === module) main()
