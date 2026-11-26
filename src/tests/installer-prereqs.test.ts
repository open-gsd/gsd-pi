import test from 'node:test'
import assert from 'node:assert/strict'
import * as prereqs from '../../scripts/install/prereqs.js'

const { isPathConfigured } = prereqs

test('isPathConfigured matches exact bin directory on PATH', () => {
  assert.equal(
    isPathConfigured('/usr/local/bin', '/usr/local/bin:/usr/bin'),
    true,
  )
  assert.equal(
    isPathConfigured('/usr/local/bin', '/usr/bin:/bin'),
    false,
  )
})

test('isPathConfigured is case-insensitive on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(
    isPathConfigured('C:\\Users\\me\\AppData\\Roaming\\npm', 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows'),
    true,
  )
  assert.equal(
    isPathConfigured('C:\\Users\\me\\AppData\\Roaming\\npm', 'c:\\users\\me\\appdata\\roaming\\npm'),
    true,
  )
})

test('git prerequisite executor throws when git command is unavailable', () => {
  assert.equal(typeof prereqs.execGitCommand, 'function')
  assert.throws(
    () => prereqs.execGitCommand('__gsd_missing_git__', ['--version']),
    /ENOENT|not found|spawn/,
  )
})

test('runtime checks fall back when CommonJS cannot require ESM output', () => {
  const err = Object.assign(new Error('require() of ES Module'), {
    code: 'ERR_REQUIRE_ESM',
  })
  const runtimeChecks = prereqs.loadRuntimeChecks(() => {
    throw err
  })

  assert.equal(runtimeChecks.MIN_NODE_VERSION, '22.19.0')
  assert.deepEqual(runtimeChecks.checkNodeVersion('22.18.9'), { ok: false, actualVersion: '22.18.9' })
  assert.deepEqual(runtimeChecks.checkNodeVersion('22.19.0'), { ok: true })
  assert.equal(runtimeChecks.requireGit(() => undefined), true)
})
