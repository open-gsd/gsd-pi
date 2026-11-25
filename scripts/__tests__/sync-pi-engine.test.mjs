import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { syncDestination } = require('../sync-pi-engine.cjs')
const repo = join(import.meta.dirname, '..', '..')
const pkgPath = join(repo, 'packages/pi-coding-agent/package.json')

function runCli(args) {
  return spawnSync(process.execPath, ['scripts/sync-pi-engine.cjs', ...args], {
    cwd: repo,
    encoding: 'utf8',
  })
}

test('no flags exits non-zero and leaves the coding-agent manifest alone', () => {
  const before = readFileSync(pkgPath)
  const result = runCli([])
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(pkgPath).equals(before), true)
})

test('dry-run exits 0 and leaves the coding-agent manifest alone', () => {
  const before = readFileSync(pkgPath)
  const result = runCli(['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /v0\.75\.5/)
  assert.match(result.stdout, /scripts\/pi-seam\.json/)
  assert.equal(readFileSync(pkgPath).equals(before), true)
  assert.match(readFileSync(pkgPath, 'utf8'), /"configDir": "\.gsd"/)
})

test('in-process sync keeps .gsd and writes the overlay bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-'))
  try {
    const upstream = join(root, 'upstream')
    const dest = join(root, 'dest')
    const overlay = join(root, 'overlay')
    const rel = 'src/keep.ts'
    mkdirSync(join(upstream, 'src'), { recursive: true })
    mkdirSync(join(dest), { recursive: true })
    mkdirSync(join(overlay, 'src'), { recursive: true })
    writeFileSync(join(upstream, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-ai',
      piConfig: { name: 'pi', configDir: '.pi' },
      publishConfig: { access: 'public' },
    }))
    writeFileSync(join(upstream, 'src/keep.ts'), 'upstream\n')
    writeFileSync(join(dest, 'package.json'), JSON.stringify({
      name: '@gsd/pi-ai',
      piConfig: { name: 'gsd', configDir: '.gsd' },
      gsd: { linkable: true },
    }))
    writeFileSync(join(overlay, rel), 'overlay\n')

    syncDestination({
      upstreamRoot: upstream,
      destRoot: dest,
      overlayRoot: overlay,
      files: [rel],
      gsdName: '@gsd/pi-ai',
    })

    const merged = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    assert.equal(merged.piConfig.configDir, '.gsd')
    assert.equal(merged.gsd.linkable, true)
    assert.equal(merged.publishConfig, undefined)
    assert.equal(readFileSync(join(dest, rel), 'utf8'), 'overlay\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('savedPackage supplies .gsd when the destination has no manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-saved-'))
  try {
    const upstream = join(root, 'upstream')
    const dest = join(root, 'dest')
    mkdirSync(upstream, { recursive: true })
    writeFileSync(join(upstream, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-ai',
      piConfig: { configDir: '.pi' },
    }))
    syncDestination({
      upstreamRoot: upstream,
      destRoot: dest,
      overlayRoot: root,
      files: [],
      gsdName: '@gsd/pi-ai',
      savedPackage: { piConfig: { name: 'gsd', configDir: '.gsd' }, gsd: { linkable: true } },
    })
    const merged = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    assert.equal(merged.name, '@gsd/pi-ai')
    assert.equal(merged.piConfig.configDir, '.gsd')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
