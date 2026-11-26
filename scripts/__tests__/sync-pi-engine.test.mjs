import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { syncDestination, applyPostVendorDeletes } = require('../sync-pi-engine.cjs')
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

test('dest inside the repo exits non-zero and leaves the manifest alone', () => {
  const before = readFileSync(pkgPath)
  const result = runCli(['--dest', join(repo, 'packages', 'pi-coding-agent')])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /outside the repo/)
  assert.equal(readFileSync(pkgPath).equals(before), true)
})

test('an external dest uses the override checkout and does not touch the repo manifest', () => {
  const upstream = mkdtempSync(join(tmpdir(), 'pi-upstream-override-'))
  const dest = mkdtempSync(join(tmpdir(), 'pi-sync-dest-'))
  const before = readFileSync(pkgPath)
  try {
    const git = (args) => execFileSync('git', args, { cwd: upstream })
    git(['init'])
    git(['config', 'user.email', 'pi-sync@example.com'])
    git(['config', 'user.name', 'pi-sync'])
    for (const dir of ['packages/agent', 'packages/ai', 'packages/tui', 'packages/coding-agent']) {
      mkdirSync(join(upstream, dir), { recursive: true })
      writeFileSync(join(upstream, dir, 'package.json'), JSON.stringify({
        name: '@earendil-works/placeholder',
        piConfig: { configDir: '.pi' },
        publishConfig: { access: 'public' },
      }))
      writeFileSync(join(upstream, dir, 'marker.txt'), 'upstream\n')
    }
    mkdirSync(join(upstream, 'packages/coding-agent/src/modes'), { recursive: true })
    writeFileSync(join(upstream, 'packages/coding-agent/src/modes/leftover.ts'), 'x\n')
    writeFileSync(join(upstream, 'packages/coding-agent/src/keep.ts'), 'keep\n')
    git(['add', '.'])
    git(['commit', '-m', 'pin'])
    git(['tag', 'v0.75.5'])
    const result = spawnSync(process.execPath, ['scripts/sync-pi-engine.cjs', '--dest', dest], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GSD_PI_UPSTREAM_ROOT: upstream },
    })
    assert.equal(result.status, 0, result.stderr)
    const aiPath = join(dest, 'packages', 'pi-ai', 'package.json')
    const codingPath = join(dest, 'packages', 'pi-coding-agent', 'package.json')
    const ai = JSON.parse(readFileSync(aiPath, 'utf8'))
    const coding = JSON.parse(readFileSync(codingPath, 'utf8'))
    assert.equal(ai.name, '@gsd/pi-ai')
    assert.equal(coding.name, '@gsd/pi-coding-agent')
    assert.equal(coding.piConfig.configDir, '.gsd')
    assert.equal(coding.publishConfig, undefined)
    assert.equal(existsSync(join(dest, 'packages', 'pi-ai', 'src', 'providers', 'fake.ts')), true)
    assert.equal(existsSync(join(dest, 'packages', 'pi-coding-agent', 'src', 'modes')), false)
    assert.equal(existsSync(join(dest, 'packages', 'pi-coding-agent', 'src', 'keep.ts')), true)
    assert.equal(readFileSync(pkgPath).equals(before), true)
  } finally {
    rmSync(upstream, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

test('post-vendor deletes remove seam paths only under the given src root', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-seam-delete-'))
  try {
    const src = join(root, 'src')
    mkdirSync(join(src, 'modes'), { recursive: true })
    writeFileSync(join(src, 'modes', 'x.ts'), 'x\n')
    writeFileSync(join(src, 'cli.ts'), 'cli\n')
    writeFileSync(join(src, 'keep.ts'), 'keep\n')
    applyPostVendorDeletes(src, ['modes', 'cli.ts'])
    assert.equal(existsSync(join(src, 'modes')), false)
    assert.equal(existsSync(join(src, 'cli.ts')), false)
    assert.equal(existsSync(join(src, 'keep.ts')), true)
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
