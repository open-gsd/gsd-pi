/**
 * Welcome screen unit tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GSD_PI_LOGO } from '../logo.ts'
import { _resetMilestoneLockForTest, primeMilestoneLock, printWelcomeScreen } from '../welcome-screen.ts'
import { closeDatabase, insertMilestone, openDatabase } from '../resources/extensions/gsd/gsd-db.ts'

function capture(opts: Parameters<typeof printWelcomeScreen>[0]): string {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: string) => { chunks.push(chunk); return true }
  const origIsTTY = (process.stderr as any).isTTY
  const origColumns = (process.stderr as any).columns
  ;(process.stderr as any).isTTY = true
  if (opts.width == null && origColumns == null) {
    ;(process.stderr as any).columns = 120
  }

  try {
    printWelcomeScreen(opts)
  } finally {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
    ;(process.stderr as any).columns = origColumns
  }

  return chunks.join('')
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

test('renders GSD-Pi block logo', () => {
  const out = strip(capture({ version: '1.0.0' }))
  for (const line of GSD_PI_LOGO) {
    assert.ok(out.includes(line.trim()), `logo row missing: ${line.trim()}`)
  }
  assert.ok(out.includes('GSD-Pi'), 'GSD-Pi brand label missing')
})

test('renders version', () => {
  const out = strip(capture({ version: '2.38.0' }))
  assert.ok(out.includes('v2.38.0'), 'version missing')
  assert.ok(out.includes('Project Console'), 'command-center title missing')
})

test('renders GSD project state or fallback hint', (t) => {
  // Model/provider intentionally removed from the welcome screen — they live
  // in the persistent footer. Without .gsd/STATE.md present the welcome
  // should surface the "No active GSD project" fallback instead.
  // chdir into an empty tmp dir so the fallback path is actually exercised
  // regardless of what the repo we're running from has in .gsd/.
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-fallback-'))
  const origCwd = process.cwd()
  process.chdir(tmp)
  t.after(() => {
    process.chdir(origCwd)
    rmSync(tmp, { recursive: true, force: true })
  })

  const out = strip(capture({ version: '1.0.0', modelName: 'claude-opus-4-6', provider: 'Anthropic' }))
  assert.ok(
    out.includes('No active GSD project') || /Active\s+M\d+/.test(out),
    'welcome should show GSD state lines or the no-project fallback',
  )
})

test('treats completed-state None sentinels as no active project', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-complete-'))
  mkdirSync(join(tmp, '.gsd'))
  writeFileSync(
    join(tmp, '.gsd', 'STATE.md'),
    [
      '**Active Milestone:** None',
      '**Phase:** complete',
      '**Active Slice:** None',
      '**Next Action:** Review the closeout.',
    ].join('\n'),
  )
  const origCwd = process.cwd()
  process.chdir(tmp)
  t.after(() => {
    process.chdir(origCwd)
    rmSync(tmp, { recursive: true, force: true })
  })

  const out = strip(capture({ version: '1.0.0', width: 120 }))
  assert.ok(out.includes('No active GSD project'))
  assert.doesNotMatch(out, /Project\s+None/)
})

test('renders cwd hint', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(out.includes('/gsd to begin'), 'hint line missing')
  assert.ok(out.includes('/gsd start'), 'primary command missing')
})

test('skips when not a TTY', (t) => {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: string) => { chunks.push(chunk); return true }
  const origIsTTY = (process.stderr as any).isTTY
  ;(process.stderr as any).isTTY = false

  t.after(() => {
    ;(process.stderr as any).write = original
    ;(process.stderr as any).isTTY = origIsTTY
  });

  printWelcomeScreen({ version: '1.0.0' })
  assert.equal(chunks.join(''), '', 'should produce no output when not TTY')
})

test('renders without model or provider', () => {
  const out = strip(capture({ version: '3.0.0' }))
  assert.ok(out.includes('v3.0.0'), 'version missing when no model provided')
})

test('renders remote channel in tools row', () => {
  const out = strip(capture({ version: '1.0.0', remoteChannel: 'discord' }))
  assert.ok(out.includes('Discord'), 'remote channel name missing')
})

test('omits remote channel when not provided', () => {
  const out = strip(capture({ version: '1.0.0' }))
  assert.ok(!out.includes('Discord'), 'should not show Discord when no remote')
  assert.ok(!out.includes('Slack'), 'should not show Slack when no remote')
  assert.ok(!out.includes('Telegram'), 'should not show Telegram when no remote')
})

test('Project row truncates with ellipsis when milestone text overflows panel width', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-test-'))
  mkdirSync(join(tmp, '.gsd'))
  writeFileSync(
    join(tmp, '.gsd', 'STATE.md'),
    [
      '**Active Milestone:** M001: Todo App – Core add/complete/delete with localStorage persistence and offline sync support',
      '**Phase:** evaluating-gates',
      '**Active Slice:** S01: implement full persistence layer with IndexedDB fallback',
    ].join('\n'),
  )
  const origCwd = process.cwd()
  process.chdir(tmp)
  const origColumns = (process.stderr as any).columns
  ;(process.stderr as any).columns = 120

  t.after(() => {
    process.chdir(origCwd)
    ;(process.stderr as any).columns = origColumns
    rmSync(tmp, { recursive: true, force: true })
  })

  const columns = (process.stderr as any).columns as number
  const out = strip(capture({ version: '1.0.0' }))
  const projectLine = out.split('\n').find(l => /Project\s+M001/.test(l))
  assert.ok(projectLine, 'Project row should be present')
  assert.ok(projectLine!.includes('…'), 'Project row should truncate long text with ellipsis')
  assert.ok(projectLine!.length <= columns, `Project row length ${projectLine!.length} should not exceed terminal width ${columns}`)
})

test('Project row does not truncate short milestone text', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-test-'))
  mkdirSync(join(tmp, '.gsd'))
  writeFileSync(join(tmp, '.gsd', 'STATE.md'), '**Active Milestone:** M001: Short title\n')
  const origCwd = process.cwd()
  process.chdir(tmp)
  const origColumns = (process.stderr as any).columns
  ;(process.stderr as any).columns = 120

  t.after(() => {
    process.chdir(origCwd)
    ;(process.stderr as any).columns = origColumns
    rmSync(tmp, { recursive: true, force: true })
  })

  const out = strip(capture({ version: '1.0.0' }))
  const projectLine = out.split('\n').find(l => /Project\s+M001/.test(l))
  assert.ok(projectLine, 'Project row should be present')
  assert.ok(projectLine!.includes('M001: Short title'), 'short title should appear in full')
  assert.ok(!projectLine!.includes('…'), 'short title should not be truncated')
})

test('command-center renders one GSD-Pi block logo with a full-width closing rule', (t) => {
  const origColumns = process.stderr.columns
  ;(process.stderr as any).columns = 250
  t.after(() => { ;(process.stderr as any).columns = origColumns })

  const out = strip(capture({ version: '1.0.0' }))
  const lines = out.split('\n')
  for (const logoLine of GSD_PI_LOGO) {
    const needle = logoLine.trim()
    assert.equal(lines.filter((l) => l.includes(needle)).length, 1, `expected one GSD-Pi logo row: ${needle}`)
  }
  // Exactly one closing rule, spanning the terminal width (columns - 1 = 249).
  const ruleLines = lines.filter(l => /^─+$/.test(l.trim()))
  assert.equal(ruleLines.length, 1, 'expected exactly one closing rule line')
  assert.equal(ruleLines[0].trim().length, 249, `rule should be 249 chars wide, got ${ruleLines[0].trim().length}`)
})

// ── GSD_MILESTONE_LOCK (#2360) ────────────────────────────────────────────────

// Projection names M001 while the session is locked to M002 — the stale
// header scenario from the issue.
const M001_STATE_MD = [
  '**Active Milestone:** M001: Todo App legacy',
  '**Phase:** evaluating-gates',
  '**Active Slice:** S01: legacy slice',
  '**Next Action:** legacy next action',
].join('\n')

type DbFixture = 'valid' | 'corrupt' | 'none'

/**
 * Create a tmp project dir (STATE.md naming M001, optional gsd.db), chdir
 * into it, set GSD_MILESTONE_LOCK, and register cleanup. Returns the dir.
 */
function setupLockFixture(
  t: { after: (fn: () => void) => void },
  lockId: string,
  db: DbFixture,
  withStateMd = true,
): string {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-welcome-lock-'))
  const gsdDir = join(tmp, '.gsd')
  mkdirSync(gsdDir, { recursive: true })
  if (withStateMd) writeFileSync(join(gsdDir, 'STATE.md'), M001_STATE_MD)
  if (db === 'valid') {
    // Real-schema DB so the locked-milestone SELECT is proven against the
    // actual table shape, not a hand-rolled stand-in.
    assert.equal(openDatabase(join(gsdDir, 'gsd.db')), true)
    insertMilestone({ id: 'M001', title: 'M001: Todo App legacy' })
    insertMilestone({ id: 'M002', title: 'M002: Payments platform' })
    closeDatabase()
  } else if (db === 'corrupt') {
    writeFileSync(join(gsdDir, 'gsd.db'), 'this is not a sqlite database')
  }

  const origCwd = process.cwd()
  const origLock = process.env.GSD_MILESTONE_LOCK
  process.chdir(tmp)
  process.env.GSD_MILESTONE_LOCK = lockId
  _resetMilestoneLockForTest()

  t.after(() => {
    process.chdir(origCwd)
    if (origLock === undefined) delete process.env.GSD_MILESTONE_LOCK
    else process.env.GSD_MILESTONE_LOCK = origLock
    _resetMilestoneLockForTest()
    rmSync(tmp, { recursive: true, force: true })
  })
  return tmp
}

test('GSD_MILESTONE_LOCK overrides the stale STATE.md projection in the header', async (t) => {
  setupLockFixture(t, 'M002', 'valid')
  await primeMilestoneLock()

  const out = strip(capture({ version: '1.0.0', width: 140 }))
  assert.match(out, /Project\s+M002/, 'header should announce the locked milestone')
  assert.ok(out.includes('M002: Payments platform'), 'locked milestone title should render')
  assert.doesNotMatch(out, /M001/, 'stale projection milestone must not appear')
  assert.doesNotMatch(out, /evaluating-gates/, 'projection phase belongs to M001 and is suppressed')
  assert.doesNotMatch(out, /legacy slice/, 'projection slice belongs to M001 and is suppressed')
  assert.doesNotMatch(out, /legacy next action/, 'projection next action belongs to M001 and is suppressed')
  assert.match(out, /\/gsd next/, 'command falls back to /gsd next without projection actions')
})

test('unknown GSD_MILESTONE_LOCK id falls open to the projection rendering', async (t) => {
  setupLockFixture(t, 'M099', 'valid')
  await primeMilestoneLock()

  const out = strip(capture({ version: '1.0.0', width: 140 }))
  assert.match(out, /Project\s+M001/, 'header falls back to STATE.md when the lock id is unknown')
  assert.match(out, /evaluating-gates/, 'projection phase renders on fallback')
  assert.match(out, /legacy next action/, 'projection next action renders on fallback')
})

test('unreadable gsd.db falls open to the projection rendering', async (t) => {
  setupLockFixture(t, 'M002', 'corrupt')
  await primeMilestoneLock()

  const out = strip(capture({ version: '1.0.0', width: 140 }))
  assert.match(out, /Project\s+M001/, 'header falls back to STATE.md when the DB cannot be opened')
  assert.match(out, /legacy next action/, 'projection next action renders on fallback')
})

test('missing gsd.db falls open without creating it', async (t) => {
  const tmp = setupLockFixture(t, 'M002', 'none')
  await primeMilestoneLock()

  const out = strip(capture({ version: '1.0.0', width: 140 }))
  assert.match(out, /Project\s+M001/, 'header falls back to STATE.md when no DB exists')
  assert.equal(existsSync(join(tmp, '.gsd', 'gsd.db')), false, 'a failed lookup must not create gsd.db')
})

test('locked milestone renders even when STATE.md is absent', async (t) => {
  setupLockFixture(t, 'M002', 'valid', false)
  await primeMilestoneLock()

  const out = strip(capture({ version: '1.0.0', width: 140 }))
  assert.match(out, /Project\s+M002/, 'the locked milestone renders without a projection file')
  assert.doesNotMatch(out, /No active GSD project/, 'a resolved lock is not "no project"')
})

test('priming with no lock set leaves the projection rendering untouched', async (t) => {
  setupLockFixture(t, '', 'none')
  await primeMilestoneLock()

  const out = strip(capture({ version: '1.0.0', width: 140 }))
  assert.match(out, /Project\s+M001/, 'without a lock the STATE.md projection renders')
  assert.match(out, /legacy next action/, 'projection next action renders when unlocked')
})

