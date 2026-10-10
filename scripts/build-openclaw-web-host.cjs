#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const { readFileSync, statSync, utimesSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { OPENCLAW_WEB_BASE_PATH, stageWebStandalone, verifyOpenClawDependencies } = require('./stage-web-standalone.cjs')

const root = resolve(__dirname, '..')
verifyOpenClawDependencies(root)
// Next rewrites these files for its active distDir. The prefixed build must not
// redirect a later standalone/dev session to its generated route declarations.
const inputs = ['tsconfig.json', 'next-env.d.ts'].map((name) => {
  const path = resolve(root, 'web', name)
  return { path, content: readFileSync(path), stat: statSync(path) }
})
let result
try {
  result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', 'gsd-web', 'run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'production', GSD_WEB_BASE_PATH: OPENCLAW_WEB_BASE_PATH, GSD_WEB_DIST_DIR: '.next-openclaw' },
  })
} finally {
  for (const input of inputs) {
    writeFileSync(input.path, input.content)
    utimesSync(input.path, input.stat.atime, input.stat.mtime)
  }
}
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
stageWebStandalone(root, { variant: 'openclaw' })
