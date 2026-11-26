import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { missingTriagePaths } = require('../check-pi-overlay-triage.cjs')

test('a table that omits a required path fails', () => {
  const markdown = '| `packages/a.ts` | purpose | keep-overlay | no |\n'
  const missing = missingTriagePaths(['packages/a.ts', 'packages/b.ts'], markdown)
  assert.deepEqual(missing, ['packages/b.ts'])
})

test('a table that names both paths passes even when dispositions differ', () => {
  const markdown = [
    '| `packages/a.ts` | one | keep-overlay | yes |',
    '| `packages/b.ts` | two | drop | no |',
  ].join('\n')
  assert.deepEqual(missingTriagePaths(['packages/a.ts', 'packages/b.ts'], markdown), [])
})

test('the repo triage covers the overlay set', () => {
  const repo = join(import.meta.dirname, '..', '..')
  const result = spawnSync(process.execPath, ['scripts/check-pi-overlay-triage.cjs'], {
    cwd: repo,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
