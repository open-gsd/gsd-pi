import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { mergeUpstreamPackage, assertCacheAtRef } = require('../vendor-pi.cjs')

test('merge keeps .gsd identity and drops publishConfig', () => {
  const merged = mergeUpstreamPackage(
    {
      name: '@earendil-works/pi-ai',
      version: '0.75.5',
      piConfig: { name: 'pi', configDir: '.pi' },
      publishConfig: { access: 'public' },
    },
    {
      name: 'old',
      piConfig: { name: 'gsd', configDir: '.gsd' },
      gsd: { linkable: true },
    },
    '@gsd/pi-ai',
  )

  assert.equal(merged.name, '@gsd/pi-ai')
  assert.equal(merged.piConfig.configDir, '.gsd')
  assert.equal(merged.gsd.linkable, true)
  assert.equal(merged.publishConfig, undefined)
})

test('explicit GSD name wins over the saved manifest name', () => {
  const merged = mergeUpstreamPackage(
    { name: '@earendil-works/pi-ai' },
    { name: 'saved-name' },
    '@gsd/pi-ai',
  )
  assert.equal(merged.name, '@gsd/pi-ai')
})

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gsd-pi-cache-'))
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'pi-preserve@example.com'])
  git(dir, ['config', 'user.name', 'pi-preserve'])
  execFileSync('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: dir })
  return dir
}

test('cache check rejects a HEAD that is not the requested ref', () => {
  const dir = tempRepo()
  try {
    const other = git(dir, ['rev-parse', 'HEAD'])
    git(dir, ['commit', '--allow-empty', '-m', 'next'])
    git(dir, ['tag', 'pinned'])
    git(dir, ['checkout', '--detach', other])
    assert.throws(() => assertCacheAtRef(dir, 'pinned'), /does not match pinned/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cache check accepts a HEAD that equals the requested ref', () => {
  const dir = tempRepo()
  try {
    git(dir, ['tag', 'pinned'])
    const head = assertCacheAtRef(dir, 'pinned')
    assert.equal(head, git(dir, ['rev-parse', 'HEAD']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
