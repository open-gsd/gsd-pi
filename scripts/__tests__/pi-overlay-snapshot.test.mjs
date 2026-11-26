import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compareSnapshots } = require('../check-pi-overlay-snapshot.cjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-overlay-'))
  const rel = 'packages/pi-ai/src/providers/fake.ts'
  mkdirSync(join(root, 'packages/pi-ai/src/providers'), { recursive: true })
  mkdirSync(join(root, 'scripts/pi-overlay/packages/pi-ai/src/providers'), { recursive: true })
  writeFileSync(join(root, rel), 'same\n')
  writeFileSync(join(root, 'scripts/pi-overlay', rel), 'same\n')
  return { root, rel }
}

test('identical snapshot bytes pass', () => {
  const { root, rel } = fixture()
  try {
    const errors = compareSnapshots(root, [rel], 'scripts/pi-overlay')
    assert.deepEqual(errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a changed snapshot byte fails and names the path', () => {
  const { root, rel } = fixture()
  try {
    writeFileSync(join(root, 'scripts/pi-overlay', rel), 'changed\n')
    const errors = compareSnapshots(root, [rel], 'scripts/pi-overlay')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /packages\/pi-ai\/src\/providers\/fake\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing snapshot fails', () => {
  const { root, rel } = fixture()
  try {
    rmSync(join(root, 'scripts/pi-overlay', rel))
    const errors = compareSnapshots(root, [rel], 'scripts/pi-overlay')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /missing snapshot/)
    assert.match(errors[0], /fake\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the repo overlay matches the checked-in engine', () => {
  const repo = join(import.meta.dirname, '..', '..')
  const code = require('node:child_process').spawnSync(process.execPath, ['scripts/check-pi-overlay-snapshot.cjs'], {
    cwd: repo,
    encoding: 'utf8',
  })
  assert.equal(code.status, 0, code.stderr || code.stdout)
})
