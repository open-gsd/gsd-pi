import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { SessionManager } from '../../packages/pi-coding-agent/src/core/session-manager.ts'
import {
  GSD_AUTO_MODE, GSD_WORKFLOW_CONTEXT, GSD_DELEGATION_CONTEXT, recordWorkflowContext, recordDelegation,
} from '../resources/extensions/shared/gsd-session-metadata.ts'
import {
  CmuxVaultBridge,
  CMUX_VAULT_MAX_PENDING_SESSIONS,
  CMUX_VAULT_DEFAULT_SOCKET_PATH,
  clearCmuxVaultBinding,
  cmuxSurfaceOwnerEnabled,
  cmuxVaultEnabled,
  cmuxVaultConfigured,
  cmuxResumeConfigured,
  cmuxVaultModes,
  createCmuxVaultExtension,
  hasManagedCmuxBridge,
  runCmuxVaultCommand,
  type CmuxVaultClearRequest,
  type CmuxVaultSession,
} from '../cmux-vault.ts'

function shellQuote(args: string[]): string {
  return args.map(value => `'${value.replace(/'/g, `'"'"'`)}'`).join(' ')
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gsd-vault-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'custom home 日本語')
  const cwd = join(root, 'project $(); spaces')
  await mkdir(cwd)
  let path: string | undefined = join(cwd, 'actual session.jsonl')
  let id = 'runtime-session-id'
  let branch: ReturnType<NonNullable<CmuxVaultSession['getBranch']>> = []
  await writeFile(path, 'private conversation must never be copied\n')
  const manager = {
    getSessionId: () => id,
    getSessionFile: () => path,
    getCwd: () => cwd,
    getBranch: () => branch,
  }
  const calls: string[][] = []
  const allCalls: string[][] = []
  const clears: CmuxVaultClearRequest[] = []
  const feedCalls: Record<string, unknown>[] = []
  let binding: Record<string, unknown> | null = null
  let capabilityFails = false
  let feedFails = false
  let failEvent: string | undefined
  let preferences: { enabled: boolean; vault: boolean; resume?: boolean } = { enabled: true, vault: true }
  let clock = 100
  // Test-only native authority. Public publication cannot create a signature.
  // Fixture-only HMAC key for the mocked native approval; it signs nothing outside this test.
  const approvalKey = ['mock', 'native', 'review', 'authority'].join('-')
  let approval: { prefix: string; cwd: string; signature: string } | undefined
  const sign = (prefix: string, cwd: string) => createHmac('sha256', approvalKey).update(JSON.stringify([prefix, cwd])).digest('hex')
  const approved = (command: string, cwd: string) => !!approval
    && approval.signature === sign(approval.prefix, approval.cwd) && cwd === approval.cwd
    // Native approval signs the full command prefix, not exact argv equality.
    && (command === approval.prefix || command.startsWith(`${approval.prefix} `))
  const result = () => ({
    workspace_id: 'workspace-uuid', surface_id: 'surface-uuid', workspace_ref: 'workspace:1', surface_ref: 'surface:2', cleared: false, resume_binding: binding,
  })
  const env = {
    GSD_CMUX_VAULT: '1',
    GSD_CMUX_VAULT_OWNER_PID: '123',
    CMUX_WORKSPACE_ID: 'workspace:1',
    CMUX_SURFACE_ID: 'surface:2',
  }
  const options = {
    home,
    launcher: ['/absolute/node', '/absolute/gsd launcher.js'],
    pid: 123,
    env,
    getPreferences: async (_cwd: string) => preferences,
    transport: async (args: string[]): Promise<Partial<ReturnType<typeof result>> & { methods?: string[]; accepted?: boolean }> => {
      allCalls.push(args)
      if (args[0] === 'rpc' && args[1] === 'system.capabilities') {
        if (capabilityFails) throw new Error('capability discovery failed')
        return { methods: ['surface.resume.conditional_set.v1'] }
      }
      if (args[0] === 'rpc') {
        feedCalls.push(JSON.parse(args[2]))
        if (feedFails || (failEvent && JSON.parse(args[2]).event.hook_event_name === failEvent)) throw new Error('feed.push transport failed')
        return { accepted: true }
      }
      if (args[2] === 'set') {
        calls.push(args)
        const option = (name: string) => args[args.indexOf(name) + 1]
        const matches = args.includes('--if-unbound') ? binding === null
          : binding?.checkpoint_id === option('--if-checkpoint-id')
            && binding?.source === option('--if-source')
            && binding?.updated_at === Number(option('--if-updated-at'))
        if (!matches) throw new Error('binding_conflict')
        binding = {
          kind: 'gsd', source: option('--source'), checkpoint_id: option('--checkpoint-id'),
          cwd: option('--cwd'), auto_resume: approved(option('--shell'), option('--cwd')), updated_at: ++clock,
          command: option('--shell'), launch_command: null,
        }
      }
      return result()
    },
    clearBinding: async (params: CmuxVaultClearRequest) => {
      clears.push(params)
      calls.push([
        'surface', 'resume', 'clear', '--workspace', 'workspace:1', '--surface', 'surface:2',
        '--checkpoint-id', params.checkpoint_id, '--source', params.source,
      ])
      const cleared = binding?.source === params.source && binding?.checkpoint_id === params.checkpoint_id && binding?.updated_at === params.expected_updated_at
      if (cleared) binding = null
      return { ...result(), cleared }
    },
  }
  return {
    root, home, cwd, calls, allCalls, clears, feedCalls, env, options, manager,
    approveNative: () => {
      assert.equal(binding?.source, 'gsd')
      assert.equal(typeof binding?.command, 'string')
      const prefix = binding!.command as string
      const cwd = binding!.cwd as string
      approval = { prefix, cwd, signature: sign(prefix, cwd) }
      binding!.auto_resume = true
    },
    setBinding: (value: Record<string, unknown> | null) => { binding = value },
    setObservedBinding: (value: Record<string, unknown> | undefined) => { binding = value ?? null },
    failCapabilityDiscovery: () => { capabilityFails = true },
    failFeed: (fail: boolean) => { feedFails = fail },
    failFeedFor: (event: string, fail: boolean) => { failEvent = fail ? event : undefined },
    setPreferences: (value: { enabled: boolean; vault: boolean; resume?: boolean }) => { preferences = value },
    setSession: (file: string | undefined, sessionId = 'switched-id') => { path = file; id = sessionId },
    setBranch: (entries: typeof branch) => { branch = entries },
    metadata: async () => {
      const directory = join(home, 'cmux', 'vault')
      return Promise.all((await readdir(directory)).map(async file => ({
        file, data: JSON.parse(await readFile(join(directory, file), 'utf8')),
        mode: (await stat(join(directory, file))).mode & 0o777,
      })))
    },
  }
}

function automaticBinding(f: Awaited<ReturnType<typeof fixture>>): Record<string, unknown> {
  return {
    kind: 'gsd', source: 'gsd', checkpoint_id: f.manager.getSessionFile(), cwd: f.cwd,
    auto_resume: true, updated_at: 101,
    command: shellQuote([
      'env', `GSD_HOME=${f.home}`, ...f.options.launcher,
      '--resume-exact', f.manager.getSessionFile()!, f.manager.getSessionId(),
    ]), launch_command: null,
  }
}

const presenceEvents = (f: Awaited<ReturnType<typeof fixture>>) => f.feedCalls.map(call =>
  (call.event as { hook_event_name: string }).hook_event_name)

test('only an explicitly enabled interactive owner in cmux is eligible', () => {
  const env = {
    GSD_CMUX_VAULT: '1', GSD_CMUX_VAULT_OWNER_PID: '42',
    CMUX_WORKSPACE_ID: 'workspace:1', CMUX_SURFACE_ID: 'surface:2',
  }
  assert.equal(cmuxVaultEnabled(env, 42), true)
  for (const key of ['GSD_CMUX_VAULT_OWNER_PID', 'CMUX_WORKSPACE_ID', 'CMUX_SURFACE_ID']) {
    assert.equal(cmuxVaultEnabled({ ...env, [key]: '' }, 42), false, key)
  }
  assert.equal(cmuxVaultEnabled(env, 43), false, 'children inherit a different owner pid')
  assert.equal(cmuxVaultEnabled({ ...env, GSD_CMUX_VAULT_EXTERNAL_BRIDGE: '1' }, 42), false)
  assert.equal(cmuxSurfaceOwnerEnabled({ ...env, GSD_CMUX_VAULT_EXTERNAL_BRIDGE: '1' }, 42), true)
})

test('Vault preferences default off, respect master disable and allow explicit environment overrides', () => {
  assert.equal(cmuxVaultConfigured({}, undefined), false)
  assert.equal(cmuxVaultConfigured({}, { enabled: true }), false)
  assert.equal(cmuxVaultConfigured({}, { enabled: true, vault: false }), false)
  assert.equal(cmuxVaultConfigured({}, { enabled: true, vault: true }), true)
  assert.equal(cmuxVaultConfigured({ GSD_CMUX_VAULT: '0' }, { enabled: true, vault: true }), false)
  assert.equal(cmuxVaultConfigured({ GSD_CMUX_VAULT: '1' }, { enabled: true }), true)
  assert.equal(cmuxVaultConfigured({ GSD_CMUX_VAULT: '1' }, { enabled: false, vault: true }), false)
  assert.equal(cmuxVaultConfigured({ GSD_CMUX_VAULT: '1' }, undefined), false)
})

test('resume preferences are opt-in and still require the cmux master switch', () => {
  assert.equal(cmuxResumeConfigured({}, undefined), false)
  assert.equal(cmuxResumeConfigured({}, { enabled: true }), false)
  assert.equal(cmuxResumeConfigured({}, { enabled: true, resume: false }), false)
  assert.equal(cmuxResumeConfigured({}, { enabled: true, resume: true }), true)
  assert.equal(cmuxResumeConfigured({ GSD_CMUX_RESUME: '0' }, { enabled: true, resume: true }), false)
  assert.equal(cmuxResumeConfigured({ GSD_CMUX_RESUME: '1' }, { enabled: true }), true)
  assert.equal(cmuxResumeConfigured({ GSD_CMUX_RESUME: '1' }, { enabled: false, resume: true }), false)
  assert.equal(cmuxResumeConfigured({ GSD_CMUX_RESUME: '1' }, undefined), false)
})

test('runtime uses current project settings without an env opt-in and clears on disable', async t => {
  const f = await fixture(t)
  let settings = { enabled: true, vault: false }
  const projects: string[] = []
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async cwd => { projects.push(cwd); return settings },
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(f.allCalls.map(args => args.slice(0, 3)), [['surface', 'resume', 'show']],
    'disabled startup only inspects for an exact persisted automatic binding')
  settings = { enabled: true, vault: true }
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls[0][2], 'set')
  settings = { enabled: false, vault: true }
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.clears.length, 1)
  assert.deepEqual(presenceEvents(f), ['SessionStart', 'SessionEnd'])
  assert.ok(projects.length >= 3)
  assert.ok(projects.every(cwd => cwd === f.cwd))
  bridge.stop()
  await bridge.idle()
})

test('public resume publication leaves native command approval available without claiming trust', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1)
  const request = f.calls[0]!
  const source = request[request.indexOf('--source') + 1]
  // cmux hides its native Resume Commands approval UI for agent-hook bindings.
  // A public CLI publisher must not claim that privileged native-hook source.
  assert.equal(source, 'gsd')
  assert.equal(request.filter(value => value === '--shell').length, 1)
  assert.equal(request.includes('--'), false)
  assert.equal(request.indexOf('--shell'), request.length - 2)
  assert.equal(request.includes('--if-unbound'), true)
  assert.notEqual(source, 'process-detected')
  assert.ok(!request.includes('--auto-resume'))
  assert.ok(!request.includes('--approval-policy'))
  bridge.stop()
  await bridge.idle()
})

test('uses actual session identity and literal argv; indexes only minimal metadata', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(f.calls, [[
    'surface', 'resume', 'set', '--workspace', 'workspace:1', '--surface', 'surface:2',
    '--name', 'GSD', '--kind', 'gsd', '--checkpoint-id', f.manager.getSessionFile(),
    '--source', 'gsd', '--cwd', f.cwd, '--if-unbound', '--shell',
    shellQuote(['env', `GSD_HOME=${f.home}`, ...f.options.launcher, '--resume-exact', f.manager.getSessionFile()!, f.manager.getSessionId()]),
  ]])
  const [record] = await f.metadata()
  assert.deepEqual(record.data, {
    sessionId: f.manager.getSessionFile(), gsdSessionId: 'runtime-session-id', cwd: f.cwd, title: 'GSD', gsdModes: [], gsdModels: [],
  })
  if (process.platform !== 'win32') {
    assert.equal(record.mode, 0o600)
    assert.equal((await stat(join(f.home, 'cmux', 'vault'))).mode & 0o777, 0o700)
  }
  assert.equal(JSON.stringify([f.calls, record.data]).includes('private conversation'), false)
  assert.equal((await readFile(f.manager.getSessionFile()!, 'utf8')), 'private conversation must never be copied\n')
  assert.deepEqual(f.feedCalls, [{
    event: {
      session_id: f.manager.getSessionFile(), hook_event_name: 'SessionStart', _source: 'gsd',
      workspace_id: 'workspace-uuid', surface_id: 'surface-uuid', cwd: f.cwd, _ppid: 123,
    },
    wait_timeout_seconds: 0,
  }])
})

test('resume preference registers the exact GSD session without Vault metadata', async t => {
  const f = await fixture(t)
  let resumeEnabled = true
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: '0' },
    getPreferences: async () => ({ enabled: true, resume: resumeEnabled, vault: false }),
  })
  bridge.update(f.manager, true)
  await bridge.idle()

  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][f.calls[0].indexOf('--shell') + 1], shellQuote([
    'env', `GSD_HOME=${f.home}`, ...f.options.launcher, '--resume-exact', f.manager.getSessionFile()!, f.manager.getSessionId(),
  ]))
  assert.equal(f.calls[0][f.calls[0].indexOf('--name') + 1], 'GSD session')
  assert.equal(f.calls[0].includes('--shell'), true)
  await assert.rejects(stat(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
  assert.deepEqual(f.feedCalls, [], 'resume-only does not register Vault feed presence')

  resumeEnabled = false
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.clears.length, 1, 'turning restore off clears its owned binding')

  bridge.stop()
  await bridge.idle()
})

test('accepts automatic restore only as reported by cmux trust policy', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_RESUME: '1' },
    getPreferences: async () => ({ enabled: true, resume: true, vault: false }),
    transport: async args => {
      const response = await f.options.transport(args) as { resume_binding?: Record<string, unknown> }
      if (args[2] !== 'set' || !response.resume_binding) return response
      return { ...response, resume_binding: { ...response.resume_binding, auto_resume: true } }
    },
  })
  bridge.update(f.manager, true)
  await bridge.idle()

  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].includes('--auto-resume'), false)
  assert.equal(f.calls[0].includes('--shell'), true)
  bridge.stop()
  await bridge.idle()
})

test('Vault-only registration clears a cmux-approved automatic binding while resume is off', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => {
      const response = await f.options.transport(args) as { resume_binding?: Record<string, unknown> }
      if (args[2] !== 'set' || !response.resume_binding) return response
      return { ...response, resume_binding: { ...response.resume_binding, auto_resume: true } }
    },
  })
  bridge.update(f.manager, true)
  await bridge.idle()

  assert.equal(f.clears.length, 1)
  const probe = await f.options.transport(['surface', 'resume', 'show'])
  assert.equal((probe as { resume_binding?: unknown }).resume_binding, null)
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
  const expectedBlocked = JSON.stringify([f.manager.getSessionId(), f.manager.getSessionFile(), f.cwd])
  const resumeEnabled = cmuxResumeConfigured(f.env, await f.options.getPreferences(f.cwd))
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1,
    `blockedMatch=${(bridge as any).blockedAutoResumeIdentity === expectedBlocked}, resumeEnabled=${resumeEnabled}`)
  assert.equal(f.clears.length, 1)
  bridge.stop()
  await bridge.idle()
})

test('disabled fresh bridge guarded-clears only its exact persisted automatic binding', async t => {
  const f = await fixture(t)
  f.setBinding(automaticBinding(f))
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async () => ({ enabled: true, vault: false, resume: false }),
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(f.allCalls, [[
    'surface', 'resume', 'show', '--workspace', 'workspace:1', '--surface', 'surface:2',
  ]])
  assert.deepEqual(f.clears, [{
    workspace_id: 'workspace-uuid', surface_id: 'surface-uuid',
    checkpoint_id: f.manager.getSessionFile(), source: 'gsd', expected_updated_at: 101,
  }])
  assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, null)
  bridge.update(f.manager, true, true)
  await bridge.idle()
  bridge.stop()
  await bridge.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 0)
  assert.equal(f.clears.length, 1, 'successful cleanup is not repeated')
  assert.deepEqual(f.feedCalls, [], 'recovered ownership never invents Vault presence')
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
})

test('disabled fresh bridge preserves manual, foreign, malformed and different-session bindings', async t => {
  for (const [name, overrides] of [
    ['manual', { auto_resume: false }],
    ['foreign kind', { kind: 'pi' }],
    ['foreign source', { source: 'cli' }],
    ['different file', { checkpoint_id: '/other/session.jsonl' }],
    ['different cwd', { cwd: '/other/project' }],
    ['different native session', { launch_command: { arguments: ['gsd', '--resume-exact', 'other-id'] } }],
    ['missing generation', { updated_at: undefined }],
    ['non-finite generation', { updated_at: NaN }],
  ] as const) {
    await t.test(name, async t => {
      const f = await fixture(t)
      const binding: Record<string, unknown> = { ...automaticBinding(f), ...overrides }
      if (name === 'different native session') {
        binding.command = (automaticBinding(f).command as string).replace(f.manager.getSessionId(), 'other-native-session-id')
      }
      f.setBinding(binding)
      const bridge = new CmuxVaultBridge({
        ...f.options,
        env: { ...f.env, GSD_CMUX_VAULT: undefined },
        getPreferences: async () => ({ enabled: false, vault: false, resume: false }),
      })
      bridge.update(f.manager, true)
      await bridge.idle()
      bridge.stop()
      await bridge.idle()
      assert.deepEqual(f.clears, [])
      assert.deepEqual(f.calls, [])
      assert.deepEqual(f.feedCalls, [])
      assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, binding)
      await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
    })
  }
})

test('automatic-binding cleanup retries later without latching a failed clear or re-registering', async t => {
  for (const failure of ['rejected', 'throws']) {
    await t.test(failure, async t => {
      const f = await fixture(t)
      const attempts: CmuxVaultClearRequest[] = []
      const bridge = new CmuxVaultBridge({
        ...f.options,
        transport: async args => {
          const response = await f.options.transport(args)
          if (args[2] !== 'set') return response
          const binding = { ...response.resume_binding, auto_resume: true }
          f.setBinding(binding)
          return { ...response, resume_binding: binding }
        },
        clearBinding: async params => {
          attempts.push(params)
          if (attempts.length === 1) {
            if (failure === 'throws') throw new Error('socket unavailable')
            return { cleared: false }
          }
          return f.options.clearBinding(params)
        },
      })
      bridge.update(f.manager, true)
      await bridge.idle()
      assert.equal(attempts.length, 1)
      const state = bridge as unknown as {
        blockedAutoResumeIdentity?: string
        binding?: { updatedAt: number }
      }
      assert.equal(state.blockedAutoResumeIdentity, undefined, 'a failed clear must not latch the block')
      assert.equal(state.binding?.updatedAt, 101, 'retain local ownership until clear succeeds')
      assert.equal(f.calls.filter(args => args[2] === 'set').length, 1)
      await bridge.idle()
      assert.equal(attempts.length, 1, 'idle does not spin on failed cleanup')
      bridge.update(f.manager, true)
      await bridge.idle()
      assert.equal(attempts.length, 2, 'next lifecycle update retries the owned generation')
      assert.deepEqual(attempts[1], attempts[0])
      assert.equal(state.blockedAutoResumeIdentity, JSON.stringify([
        f.manager.getSessionId(), f.manager.getSessionFile(), f.cwd,
      ]))
      assert.equal(state.binding, undefined)
      assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, null)
      bridge.update(f.manager, true, true)
      await bridge.idle()
      bridge.stop()
      await bridge.idle()
      assert.equal(attempts.length, 2, 'only a successful clear latches the block')
      assert.equal(f.calls.filter(args => args[2] === 'set').length, 1)
      assert.deepEqual(f.feedCalls, [])
      await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
    })
  }
})

test('fresh disabled cleanup retains its guarded generation when a foreign owner replaces it', async t => {
  const f = await fixture(t)
  f.setBinding(automaticBinding(f))
  const foreign = { ...automaticBinding(f), kind: 'pi', updated_at: 999 }
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async () => ({ enabled: true, vault: false, resume: false }),
    clearBinding: async params => {
      f.setBinding(foreign)
      return f.options.clearBinding(params)
    },
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.clears.length, 1)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.clears.length, 2, 'later update retries instead of forgetting ownership')
  bridge.stop()
  await bridge.idle()
  // Shutdown ends presence only; the durable binding is not cleared at quit.
  assert.equal(f.clears.length, 2, 'shutdown does not clear the durable binding')
  assert.ok(f.clears.every(params => params.expected_updated_at === 101))
  assert.equal(f.allCalls.filter(args => args[2] === 'show').length, 1,
    'a failed clear never adopts the replacement generation')
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 0)
  assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, foreign)
  assert.deepEqual(f.feedCalls, [])
})

test('disabling Vault for the same file ends presence once while keeping the resume binding', async t => {
  const f = await fixture(t)
  let vault = true
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async () => ({ enabled: true, vault, resume: true }),
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(presenceEvents(f), ['SessionStart'])
  vault = false
  for (let i = 0; i < 2; i++) {
    bridge.update(f.manager, true, true)
    await bridge.idle()
  }
  assert.deepEqual(presenceEvents(f), ['SessionStart', 'SessionEnd'])
  assert.equal(f.clears.length, 0, 'Vault disable does not remove opted-in resume')
  const binding = (await f.options.transport(['surface', 'resume', 'show'])).resume_binding
  assert.equal(binding?.checkpoint_id, f.manager.getSessionFile())
  assert.equal((await f.metadata()).length, 1)
  bridge.stop()
  await bridge.idle()
  // Shutdown ends presence but keeps the durable resume binding (see the
  // graceful-shutdown regression test); it must not clear it.
  assert.equal(f.clears.length, 0, 'shutdown keeps the durable resume binding')
  assert.deepEqual(presenceEvents(f), ['SessionStart', 'SessionEnd'], 'shutdown does not end twice')
})

test('safety cleanup ends prior Vault presence once even when the guarded clear must retry', async t => {
  const f = await fixture(t)
  let automatic = false
  const attempts: CmuxVaultClearRequest[] = []
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => {
      const response = await f.options.transport(args)
      if (args[2] !== 'set' || !automatic) return response
      const binding = { ...response.resume_binding, auto_resume: true }
      f.setBinding(binding)
      return { ...response, resume_binding: binding }
    },
    clearBinding: async params => {
      attempts.push(params)
      if (attempts.length === 1) return { cleared: false }
      return f.options.clearBinding(params)
    },
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(presenceEvents(f), ['SessionStart'])
  automatic = true
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(attempts.length, 1)
  assert.deepEqual(presenceEvents(f), ['SessionStart', 'SessionEnd'])
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 2)
  bridge.stop()
  await bridge.idle()
  assert.deepEqual(presenceEvents(f), ['SessionStart', 'SessionEnd'])
  assert.equal(attempts.length, 2)
})

test('shutdown ends Vault presence and never clears a foreign or durable binding', async t => {
  for (const failure of ['changed', 'throws']) {
    await t.test(failure, async t => {
      const f = await fixture(t)
      const foreign = {
        kind: 'pi', source: 'cli', checkpoint_id: '/foreign/session.jsonl', cwd: '/foreign/project',
        auto_resume: false, updated_at: 999, launch_command: { arguments: ['pi'] },
      }
      let attempts = 0
      const bridge = new CmuxVaultBridge({
        ...f.options,
        clearBinding: async params => {
          attempts++
          if (failure === 'throws') throw new Error('socket unavailable')
          return f.options.clearBinding(params)
        },
      })
      bridge.update(f.manager, true)
      await bridge.idle()
      assert.deepEqual(presenceEvents(f), ['SessionStart'])
      // Another owner takes the surface after our publish. Shutdown must neither
      // clear it nor even try the guarded clear.
      f.setBinding(foreign)
      bridge.stop()
      await bridge.idle()
      assert.equal(attempts, 0, 'shutdown never attempts the guarded clear')
      assert.deepEqual(presenceEvents(f), ['SessionStart', 'SessionEnd'])
      assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, foreign)
    })
  }
})

test('duplicate startup is idempotent and completed turns refresh one record', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  bridge.update(f.manager, true)
  await bridge.idle()
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1)
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 2)
  assert.equal((await f.metadata()).length, 1)
})

test('mode classification reads only runtime tags, never conversation or workflow contents', async t => {
  const f = await fixture(t)
  const secret = {
    get content(): never { throw new Error('must not inspect conversation') },
    get details(): never { throw new Error('must not inspect workflow metadata') },
  }
  const tagged = (customType: string) => Object.assign(Object.create(secret), { type: 'custom_message', customType })
  f.setBranch([
    { type: 'message', message: Object.assign(Object.create(secret), { role: 'user' }) },
    tagged('gsd-auto'), tagged('gsd-quick-task'),
    tagged('gsd-debug-start'), tagged('gsd-debug-continue'), tagged('gsd-debug-diagnose'),
    tagged('gsd-auto'), tagged('arbitrary-private-workflow-name'),
    { type: 'custom', customType: 'gsd-auto' },
    { type: 'message', message: { role: 'assistant' } },
    { type: 'message', message: { role: 'toolResult' } },
  ])
  assert.deepEqual(cmuxVaultModes(f.manager), ['chat', 'auto', 'quick', 'debug'])
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const [record] = await f.metadata()
  assert.deepEqual(record.data.gsdModes, ['chat', 'auto', 'quick', 'debug'])
  assert.equal(record.data.title, 'GSD — Chat / Auto / Quick / Debug')
  assert.equal(f.calls[0][f.calls[0].indexOf('--name') + 1], record.data.title)
  assert.equal(JSON.stringify(record.data).includes('arbitrary-private-workflow-name'), false)
})

test('quick/debug mix in one native conversation and resume reconstructs modes without sidecar reads', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  f.setBranch([{ type: 'message', message: { role: 'user' } }])
  bridge.update(f.manager, true)
  await bridge.idle()
  f.setBranch([
    ...f.manager.getBranch(),
    { type: 'custom_message', customType: 'gsd-quick-task' },
    { type: 'custom_message', customType: 'gsd-debug-start' },
  ])
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal((await f.metadata()).length, 1, 'commands do not create synthetic Vault sessions')
  assert.deepEqual((await f.metadata())[0].data.gsdModes, ['chat', 'quick', 'debug'])
  const resumed = new CmuxVaultBridge(f.options)
  resumed.update(f.manager, true)
  await resumed.idle()
  assert.equal((await f.metadata())[0].data.title, 'GSD — Chat / Quick / Debug')
  const file = join(f.cwd, 'auto-unit.jsonl')
  await writeFile(file, 'private unit transcript')
  f.setSession(file, 'auto-unit-id')
  f.setBranch([{ type: 'custom_message', customType: 'gsd-auto' }])
  resumed.update(f.manager, true)
  await resumed.idle()
  const records = await f.metadata()
  assert.equal(records.length, 2)
  assert.deepEqual(records.find(record => record.data.sessionId === file)?.data.gsdModes, ['auto'])
  assert.deepEqual(records.find(record => record.data.sessionId !== file)?.data.gsdModes, ['chat', 'quick', 'debug'])
})

test('real session persistence, branch selection and resume retain only native-branch mode tags', async t => {
  const f = await fixture(t)
  const session = SessionManager.create(f.cwd, join(f.root, 'native-sessions'))
  const user = session.appendMessage({ role: 'user', content: 'private user task', timestamp: 1 })
  const writer = { appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data) } }
  recordWorkflowContext(writer, () => session.getSessionId(), 'M003-ab12cd/S02/T03')
  const finish = recordDelegation(writer, () => session.getSessionId(), {
    id: '32fd3341-a765-46af-ae2d-2f82051749a0', mode: 'parallel', count: 3, forkCount: 1, background: true,
  })
  finish(2, 1)
  session.appendCustomMessageEntry('gsd-quick-task', 'private quick plan', false, { secret: 'private details' })
  session.appendCustomMessageEntry('gsd-debug-start', 'private issue and stack trace', false)
  session.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'private response' }],
    api: 'openai-completions', provider: 'openai', model: 'test',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 2,
  })
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(session, true)
  await bridge.idle()
  assert.deepEqual((await f.metadata())[0].data.gsdModes, ['chat', 'quick', 'debug'])
  assert.equal((await f.metadata())[0].data.gsdWorkflow.taskId, 'T03')
  assert.equal((await f.metadata())[0].data.gsdDelegations[0].status, 'settled')
  const resumed = SessionManager.open(session.getSessionFile()!)
  assert.deepEqual(cmuxVaultModes(resumed), ['chat', 'quick', 'debug'])
  bridge.update(resumed, true, true)
  await bridge.idle()
  assert.equal((await f.metadata())[0].data.gsdWorkflow.milestoneId, 'M003-ab12cd')
  assert.equal((await f.metadata())[0].data.gsdDelegations[0].successCount, 2)
  resumed.branch(user)
  assert.deepEqual(cmuxVaultModes(resumed), ['chat'], 'abandoned branch tags do not bleed into current branch')
  resumed.appendCustomMessageEntry('gsd-auto', 'private auto instructions', false)
  assert.deepEqual(cmuxVaultModes(resumed), ['chat', 'auto'])
  resumed.newSession()
  assert.deepEqual(cmuxVaultModes(resumed), [], 'new auto unit does not inherit the previous conversation modes')
})

test('hierarchy and parallel delegation annotations expose only validated owning-session metadata', async t => {
  const f = await fixture(t)
  const originSessionId = f.manager.getSessionId()
  const request = {
    version: 1, originSessionId, id: '32fd3341-a765-46af-ae2d-2f82051749a0',
    mode: 'parallel', count: 3, forkCount: 1, background: true, status: 'requested',
  }
  f.setBranch([
    { type: 'custom_message', customType: 'gsd-auto' },
    { type: 'custom', customType: GSD_WORKFLOW_CONTEXT, data: {
      version: 1, originSessionId, milestoneId: 'M001-ab12cd', sliceId: 'S02', taskId: 'T03',
      get title(): never { throw new Error('must not inspect artifact titles') },
    } },
    { type: 'custom', customType: GSD_DELEGATION_CONTEXT, data: request },
    { type: 'custom', customType: GSD_DELEGATION_CONTEXT, data: {
      ...request, status: 'settled', successCount: 1, failureCount: 1,
      get output(): never { throw new Error('must not inspect subagent output') },
    } },
    { type: 'custom', customType: GSD_DELEGATION_CONTEXT, data: {
      ...request, id: '22fd3341-a765-46af-ae2d-2f82051749a0', originSessionId: 'fork-parent',
    } },
    { type: 'custom', customType: GSD_WORKFLOW_CONTEXT, data: {
      version: 1, originSessionId, milestoneId: 'secret project title',
    } },
    { type: 'custom', customType: 'external-usage',
      get data(): never { throw new Error('must not inspect name-bearing usage or workflow logs') } },
  ])
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const [record] = await f.metadata()
  assert.equal(record.data.title, 'GSD — Auto · M001-ab12cd/S02/T03 · Subagents ×3 (parallel)')
  assert.deepEqual(record.data.gsdWorkflow, { originSessionId, milestoneId: 'M001-ab12cd', sliceId: 'S02', taskId: 'T03' })
  assert.equal(record.data.gsdDelegations.length, 1)
  assert.deepEqual(record.data.gsdDelegations[0], {
    originSessionId, id: request.id, mode: 'parallel', count: 3, forkCount: 1,
    background: true, status: 'settled', successCount: 1, failureCount: 1,
  })
  assert.equal(JSON.stringify(record.data).includes('secret'), false)
  assert.equal(JSON.stringify(f.feedCalls).includes('M001'), false, 'Feed remains content-free lifecycle presence')
})

test('turn_end snapshots the persisted auto session before an agent_end session handoff', async t => {
  const f = await fixture(t)
  const handlers = new Map<string, Function>()
  let published!: () => void
  const done = new Promise<void>(resolve => { published = resolve })
  await createCmuxVaultExtension({
    ...f.options,
    transport: async args => {
      const result = await f.options.transport(args)
      if (args[0] === 'rpc' && args[1] === 'feed.push') published()
      return result
    },
  })({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never)
  f.setBranch([{ type: 'custom_message', customType: 'gsd-auto' }])
  const file = f.manager.getSessionFile()
  const ctx = { sessionManager: f.manager, hasUI: true }
  const privateEvent = {
    get message(): never { throw new Error('must not inspect response') },
    get toolResults(): never { throw new Error('must not inspect tool output') },
  }
  assert.equal(handlers.get('turn_end')!(privateEvent, ctx), undefined)
  f.setSession(join(f.cwd, 'next-not-persisted.jsonl'))
  f.setBranch([])
  await done
  const [record] = await f.metadata()
  assert.equal(record.data.sessionId, file)
  assert.deepEqual(record.data.gsdModes, ['auto'])
  handlers.get('agent_end')!({}, ctx)
  await handlers.get('session_shutdown')!()
})

test('slow surface transport coalesces bindings without dropping completed auto-session metadata', async t => {
  const f = await fixture(t)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => { entered(); await gate; return f.options.transport(args) },
  })
  bridge.update(f.manager, true)
  await started
  f.setBranch([{ type: 'custom_message', customType: 'gsd-auto' }])
  bridge.update(f.manager, true, true)
  const files = [f.manager.getSessionFile()!]
  for (let i = 0; i < 3; i++) {
    const file = join(f.cwd, `auto-unit-${i}.jsonl`)
    await writeFile(file, 'private unit transcript')
    files.push(file)
    f.setSession(file, `auto-${i}`)
    f.setBranch([{ type: 'custom_message', customType: 'gsd-auto' }])
    bridge.update(f.manager, true, true)
  }
  release()
  await bridge.idle()
  const records = await f.metadata()
  assert.deepEqual(records.map(record => record.data.sessionId).sort(), files.sort())
  assert.ok(records.every(record => record.data.gsdModes.join() === 'auto'))
  assert.equal(f.calls.filter(call => call[2] === 'set').length, 2, 'surface target still coalesces')
  assert.equal(f.calls.at(-1)?.[f.calls.at(-1)!.indexOf('--checkpoint-id') + 1], f.manager.getSessionFile())
})

test('pending session catalogs and exported delegation history remain bounded', async t => {
  const f = await fixture(t)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => { entered(); await gate; return f.options.transport(args) },
  })
  bridge.update(f.manager, true)
  await started
  for (let i = 0; i < CMUX_VAULT_MAX_PENDING_SESSIONS + 2; i++) {
    const file = join(f.cwd, `buffered-${i}.jsonl`)
    await writeFile(file, 'private transcript')
    f.setSession(file)
    bridge.update(f.manager, true)
  }
  const originSessionId = f.manager.getSessionId()
  f.setBranch(Array.from({ length: 70 }, (_, index) => ({
    type: 'custom', customType: GSD_DELEGATION_CONTEXT, data: {
      version: 1, originSessionId, id: `${index.toString(16).padStart(8, '0')}-a765-46af-ae2d-2f82051749a0`,
      mode: 'single', count: 1, forkCount: 0, background: false, status: 'requested',
    },
  })))
  bridge.update(f.manager, true, true)
  release()
  await bridge.idle()
  const records = await f.metadata()
  assert.equal(records.length, CMUX_VAULT_MAX_PENDING_SESSIONS + 1, 'one active plus bounded pending snapshots')
  assert.ok(!records.some(record => record.data.sessionId.endsWith('buffered-0.jsonl')))
  const latest = records.find(record => record.data.sessionId === f.manager.getSessionFile())!
  assert.equal(latest.data.gsdDelegations.length, 64)
  assert.equal(latest.data.gsdDelegations[0].id.startsWith('00000045-'), true, 'newest observations win')
})

test('switch/resume updates only this surface; in-memory/new unsaved session clears its binding', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const second = join(f.cwd, 'resumed.jsonl')
  await writeFile(second, 'another private conversation')
  f.setSession(second)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.calls[1][f.calls[1].indexOf('--checkpoint-id') + 1], second)
  assert.equal((await f.metadata()).length, 2, 'only observed sessions, no history crawl')
  f.setSession(undefined)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(f.calls[2], [
    'surface', 'resume', 'clear', '--workspace', 'workspace:1', '--surface', 'surface:2',
    '--checkpoint-id', second, '--source', 'gsd',
  ])
  bridge.stop()
  await bridge.idle()
  assert.equal(f.calls.length, 3, 'already-cleared binding is not cleared twice')
  assert.deepEqual(f.feedCalls.map(call => (call.event as { hook_event_name: string }).hook_event_name),
    ['SessionStart', 'SessionEnd', 'SessionStart', 'SessionEnd'])
  assert.deepEqual(f.clears, [{
    workspace_id: 'workspace-uuid', surface_id: 'surface-uuid', checkpoint_id: second,
    source: 'gsd', expected_updated_at: 102,
  }])
})

test('fresh session is published only after the actual runtime file is persisted', async t => {
  const f = await fixture(t)
  const file = join(f.cwd, 'new.jsonl')
  f.setSession(file)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.calls.length, 0)
  await writeFile(file, 'persisted privately')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1)
})

test('switching from a persisted session to a missing file clears the old generation immediately', async t => {
  const f = await fixture(t)
  const previous = f.manager.getSessionFile()
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  f.setSession(join(f.cwd, 'not-persisted-yet.jsonl'))
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1][2], 'clear')
  assert.equal(f.clears[0].checkpoint_id, previous)
  assert.equal(f.clears[0].expected_updated_at, 101)
})

test('disabled owners only inspect; outside cmux, child and noninteractive sessions do nothing', async t => {
  const f = await fixture(t)
  for (const overrides of [
    { GSD_CMUX_VAULT: '0' }, { CMUX_SURFACE_ID: '' },
    { CMUX_WORKSPACE_ID: '' }, { GSD_CMUX_VAULT_OWNER_PID: '999' },
    { GSD_CMUX_VAULT_EXTERNAL_BRIDGE: '1' },
  ]) {
    const bridge = new CmuxVaultBridge({ ...f.options, env: { ...f.env, ...overrides } })
    bridge.update(f.manager, true)
    bridge.stop()
    await bridge.idle()
  }
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, false)
  bridge.stop()
  await bridge.idle()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.allCalls.map(args => args.slice(0, 3)), [
    ['surface', 'resume', 'show'], ['surface', 'resume', 'show'],
  ], 'disabled and external-Vault owners may only inspect for stale automatic bindings')
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
})

test('upstream managed injection marker suppresses the bridge, not merely a filename', async t => {
  const f = await fixture(t)
  const extension = join(f.root, 'cmux-session.ts')
  await writeFile(extension, 'not a managed bridge')
  assert.equal(await hasManagedCmuxBridge([extension]), false)
  await writeFile(extension, '// cmux-pi-session-extension-marker v4\n')
  const bridge = new CmuxVaultBridge({ ...f.options, extensionPaths: () => [extension] })
  bridge.update(f.manager, true)
  bridge.stop()
  await bridge.idle()
  assert.deepEqual(f.calls, [])
})

test('resume opt-in keeps the GSD launcher when the managed Pi bridge is installed', async t => {
  const f = await fixture(t)
  const extension = join(f.root, 'cmux-pi-session.ts')
  await writeFile(extension, '// cmux-pi-session-extension-marker v4\\n')
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: '0' },
    extensionPaths: () => [extension],
    getPreferences: async () => ({ enabled: true, resume: true, vault: false }),
  })
  bridge.update(f.manager, true)
  await bridge.idle()

  assert.equal(f.calls.length, 1)
  const command = f.calls[0][f.calls[0].indexOf('--shell') + 1]
  assert.equal(command, shellQuote(['env', `GSD_HOME=${f.home}`, ...f.options.launcher,
    '--resume-exact', f.manager.getSessionFile()!, f.manager.getSessionId()]))
  assert.equal(f.calls[0].includes('--'), false)
  bridge.stop()
  await bridge.idle()
})

test('managed Pi Vault ownership suppresses GSD publish and queued snapshots but retains exact resume', async t => {
  const f = await fixture(t)
  const extension = join(f.root, 'cmux-pi-session.ts')
  await writeFile(extension, '// cmux-pi-session-extension-marker v4\n')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    extensionPaths: () => [extension],
    getPreferences: async () => ({ enabled: true, vault: true, resume: true }),
    transport: async args => { entered(); await gate; return f.options.transport(args) },
  })
  bridge.update(f.manager, true)
  await started
  const second = join(f.cwd, 'managed-vault-next.jsonl')
  await writeFile(second, 'private native session')
  f.setSession(second)
  bridge.update(f.manager, true)
  release()
  await bridge.idle()
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(args => args[args.indexOf('--name') + 1] === 'GSD session'))
  const binding = (await f.options.transport(['surface', 'resume', 'show'])).resume_binding
  assert.equal(binding?.checkpoint_id, second)
  assert.equal(binding?.launch_command, null)
  assert.equal(binding?.command, shellQuote([
    'env', `GSD_HOME=${f.home}`, ...f.options.launcher, '--resume-exact', second, f.manager.getSessionId(),
  ]))
  assert.deepEqual(f.feedCalls, [], 'managed Pi bridge is the sole Vault presence writer')
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
  bridge.stop()
  await bridge.idle()
  // Shutdown keeps the durable binding; only the earlier explicit opt-out cleared.
  assert.equal(f.clears.length, 0, 'shutdown keeps the durable resume binding')
  assert.deepEqual(f.feedCalls, [], 'resume cleanup does not invent a GSD Vault end')
})

test('resume opt-in never overwrites a different agent binding on the surface', async t => {
  const f = await fixture(t)
  f.setBinding({
    kind: 'pi', source: 'agent-hook', checkpoint_id: f.manager.getSessionFile(), cwd: f.cwd,
    updated_at: 99, launch_command: { arguments: ['pi', '--session', f.manager.getSessionId()] },
  })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: '0' },
    getPreferences: async () => ({ enabled: true, resume: true, vault: false }),
  })
  bridge.update(f.manager, true)
  await bridge.idle()

  assert.deepEqual(f.calls, [])
  const probe = await f.options.transport(['surface', 'resume', 'show'])
  assert.equal((probe as { resume_binding?: { kind?: string } }).resume_binding?.kind, 'pi')
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
  bridge.stop()
  await bridge.idle()
})

test('transport failure never rejects lifecycle; next turn retries safely', async t => {
  const f = await fixture(t)
  let fail = true
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => {
      if (fail) throw new Error('stale socket / missing executable')
      return f.options.transport(args)
    },
  })
  assert.doesNotThrow(() => bridge.update(f.manager, true))
  await bridge.idle()
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
  fail = false
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1)
  bridge.stop()
  await bridge.idle()
  // A stopped bridge ignores later lifecycle updates (update() returns on
  // this.stopped); shutdown must not trigger another surface call.
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1)
})

test('queue coalesces updates and shutdown wins over pending session changes', async t => {
  const f = await fixture(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => { await gate; return f.options.transport(args) },
  })
  bridge.update(f.manager, true)
  await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 100; i++) bridge.update(f.manager, true, true)
  bridge.stop()
  release()
  await bridge.idle()
  // Shutdown must not clear the durable binding. The in-flight publish completes,
  // and the queued refresh that was already waiting is drained first (one set each),
  // so a refresh queued before shutdown is never silently dropped.
  assert.equal(f.calls.some(args => args[2] === 'clear'), false, 'shutdown never clears the durable binding')
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 2, 'in-flight publish and the queued refresh both drain')
})

test('extension factory attaches supported post-switch lifecycle events without reading event content', async t => {
  const f = await fixture(t)
  const handlers = new Map<string, Function>()
  const factory = createCmuxVaultExtension(f.options)
  await factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never)
  assert.deepEqual([...handlers.keys()], ['session_start', 'session_tree', 'model_select', 'turn_end', 'agent_end', 'session_shutdown'])
  const ctx = { sessionManager: f.manager, hasUI: false }
  assert.doesNotThrow(() => handlers.get('agent_end')!({ messages: ['secret'] }, ctx))
  await handlers.get('session_shutdown')!()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, [])
})

test('enabled lifecycle handlers return immediately, refresh on agent_end and drain on shutdown', async t => {
  const f = await fixture(t)
  const handlers = new Map<string, Function>()
  const waiters: Array<() => void> = []
  await createCmuxVaultExtension({
    ...f.options,
    transport: async args => {
      const result = await f.options.transport(args)
      if (args[0] === 'rpc' && args[1] === 'feed.push') waiters.shift()?.()
      return result
    },
  })({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never)
  const ctx = { sessionManager: f.manager, hasUI: true }
  const first = new Promise<void>(resolve => waiters.push(resolve))
  assert.equal(handlers.get('session_start')!({}, ctx), undefined)
  await first
  const next = new Promise<void>(resolve => waiters.push(resolve))
  const privateEvent = { get messages() { throw new Error('must not inspect transcript') } }
  assert.equal(handlers.get('agent_end')!(privateEvent, ctx), undefined)
  await next
  await handlers.get('session_shutdown')!()
  assert.equal(f.calls.filter(call => call[2] === 'set').length, 2)
  // Shutdown drains presence but keeps the durable exact-resume binding.
  assert.equal(f.clears.length, 0, 'shutdown keeps the durable resume binding')
  assert.equal((f.feedCalls.at(-1)?.event as { hook_event_name: string }).hook_event_name, 'SessionEnd')
})

test('session_tree refreshes selected branch modes and removes abandoned workflow and delegation context', async t => {
  const f = await fixture(t)
  const handlers = new Map<string, Function>()
  const waiters: Array<() => void> = []
  await createCmuxVaultExtension({
    ...f.options,
    transport: async args => {
      const result = await f.options.transport(args)
      if (args[0] === 'rpc' && args[1] === 'feed.push') waiters.shift()?.()
      return result
    },
  })({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never)
  const ctx = { sessionManager: f.manager, hasUI: true }
  const originSessionId = f.manager.getSessionId()
  f.setBranch([
    { type: 'custom_message', customType: 'gsd-quick-task' },
    { type: 'custom_message', customType: 'gsd-debug-start' },
    { type: 'custom', customType: GSD_WORKFLOW_CONTEXT, data: {
      version: 1, originSessionId, milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    } },
    { type: 'custom', customType: GSD_DELEGATION_CONTEXT, data: {
      version: 1, originSessionId, id: '32fd3341-a765-46af-ae2d-2f82051749a0',
      mode: 'parallel', count: 2, forkCount: 0, background: false, status: 'requested',
    } },
  ])
  const started = new Promise<void>(resolve => waiters.push(resolve))
  handlers.get('session_start')!({}, ctx)
  await started
  assert.deepEqual((await f.metadata())[0].data.gsdModes, ['quick', 'debug'])
  f.setBranch([{ type: 'message', message: { role: 'user' } }])
  const refreshed = new Promise<void>(resolve => waiters.push(resolve))
  assert.equal(handlers.get('session_tree')!({
    get summaryEntry(): never { throw new Error('must not inspect branch summaries') },
  }, ctx), undefined)
  await refreshed
  const [record] = await f.metadata()
  assert.deepEqual(record.data.gsdModes, ['chat'])
  assert.equal(record.data.title, 'GSD — Chat')
  assert.equal(record.data.gsdWorkflow, undefined)
  assert.equal(record.data.gsdDelegations, undefined)
  assert.equal(record.data.sessionId, f.manager.getSessionFile())
  assert.equal(f.calls.at(-1)?.[f.calls.at(-1)!.indexOf('--name') + 1], 'GSD — Chat')

  f.setBranch([
    { type: 'model_change', provider: 'github-copilot', modelId: 'claude-fable-5' },
    { type: 'message', message: { role: 'user' } },
  ])
  const modelSelected = new Promise<void>(resolve => waiters.push(resolve))
  assert.equal(handlers.get('model_select')!({
    get model(): never { throw new Error('must not inspect model selection event') },
  }, ctx), undefined)
  await modelSelected
  const [selectedModelRecord] = await f.metadata()
  assert.deepEqual(selectedModelRecord.data.gsdModels, [
    { provider: 'github-copilot', modelId: 'claude-fable-5' },
  ])
  assert.equal(selectedModelRecord.data.title, 'GSD — Chat · github-copilot:claude-fable-5')
  await handlers.get('session_shutdown')!()
})

test('real subprocess transport preserves argv and rejects malformed output, failure and timeout', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const cli = join(f.root, 'cmux')
  await writeFile(cli, `#!/bin/sh
[ "$1" = '--json' ] && [ "$2" = '--id-format' ] && [ "$3" = 'both' ] || exit 4
case "$4" in
  bad-json) [ "$#" -eq 4 ] || exit 5; printf 'not json' ;;
  fail) [ "$#" -eq 4 ] || exit 5; exit 1 ;;
  hang) [ "$#" -eq 4 ] || exit 5; exec sleep 10 ;;
  literal)
    [ "$#" -eq 5 ] || exit 5
    [ "$5" = '日本語 spaces; $(touch not-a-command)' ] || exit 2
    printf '%s' '{"args":["--json","--id-format","both","literal","日本語 spaces; $(touch not-a-command)"]}'
    ;;
  *) exit 3 ;;
esac
`, { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = `${f.root}:${previous}`
  t.after(() => { process.env.PATH = previous })
  const literal = '日本語 spaces; $(touch not-a-command)'
  assert.deepEqual(await runCmuxVaultCommand(['literal', literal]), { args: ['--json', '--id-format', 'both', 'literal', literal] })
  await assert.rejects(runCmuxVaultCommand(['bad-json']))
  await assert.rejects(runCmuxVaultCommand(['fail']))
  const start = Date.now()
  await assert.rejects(runCmuxVaultCommand(['hang']))
  assert.ok(Date.now() - start < 5000, 'timeout is bounded')
  process.env.PATH = join(f.root, 'no-executables')
  await assert.rejects(runCmuxVaultCommand(['missing']), { code: 'ENOENT' })
  process.env.PATH = `${f.root}:${previous}`
  // Exercise an inherited owner marker in a real child without cmux or history.
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [
      '--import', new URL('../resources/extensions/gsd/tests/resolve-ts.mjs', import.meta.url).href,
      '--experimental-strip-types', '--input-type=module', '-e',
      `import { cmuxVaultEnabled } from ${JSON.stringify(new URL('../cmux-vault.ts', import.meta.url).href)};
       console.log(cmuxVaultEnabled(process.env, process.pid));`,
    ], { env: { ...process.env, ...f.env, GSD_CMUX_VAULT_OWNER_PID: String(process.pid) } },
    (error, stdout) => error ? reject(error) : resolve(stdout))
  })
  assert.equal(output.trim(), 'false')
})

test('malformed, foreign and replaced bindings fail closed without sidecars or clobbering', async t => {
  const f = await fixture(t)
  for (const response of [{}, { resume_binding: [] }, { resume_binding: null }, null]) {
    let showCalls = 0
    const bridge = new CmuxVaultBridge({
      ...f.options,
      transport: async args => {
        if (args[0] === 'surface' && args[2] === 'show') {
          showCalls++
          return response
        }
        return f.options.transport(args)
      },
    })
    bridge.update(f.manager, true)
    await bridge.idle()
    assert.equal(showCalls, 1, 'malformed responses must reach resume show, not fail capability discovery')
    assert.equal(f.calls.length, 0, 'malformed show responses must not publish a binding')
  }
  for (const foreign of [
    { kind: 'pi', source: 'agent-hook' },
    { kind: 'gsd', source: 'manual', checkpoint_id: f.manager.getSessionFile() },
    { kind: 'gsd', source: 'agent-hook', checkpoint_id: '/someone/else.jsonl' },
  ]) {
    f.setBinding(foreign)
    const bridge = new CmuxVaultBridge(f.options)
    bridge.update(f.manager, true)
    await bridge.idle()
  }
  assert.deepEqual(f.calls, [])
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
})

test('a replaced same-session generation cannot be cleared by its predecessor', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const replacement = {
    kind: 'gsd', source: 'gsd', checkpoint_id: f.manager.getSessionFile(),
    updated_at: 999,
  }
  f.setBinding(replacement)
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1, 'preflight refuses replacement ownership')
  bridge.stop()
  await bridge.idle()
  // Shutdown never clears; the predecessor must not touch the replacement that
  // cmux now owns, so no clear is issued and the replacement is left in place.
  assert.equal(f.clears.length, 0, 'shutdown never clears, so a replacement is never removed')
  const probe = await f.options.transport(['surface', 'resume', 'show'])
  assert.equal(probe.resume_binding, replacement)
})

test('effective set responses must retain the exact shell identity and cmux policy', async t => {
  const f = await fixture(t)
  for (const invalid of [
    { auto_resume: 'not-a-boolean' },
    { kind: 'pi' },
    { checkpoint_id: '/retained/other-session.jsonl' },
    { updated_at: 'not-a-generation' },
    { updated_at: Infinity },
    { source: 'agent-hook' },
    { command: 'gsd --continue' },
    { cwd: '/foreign' },
    { environment: { GSD_HOME: '/foreign' } },
    { launch_command: { arguments: ['pi', '--continue'] } },
  ]) {
    f.setBinding(null)
    const bridge = new CmuxVaultBridge({
      ...f.options,
      transport: async args => {
        const response = await f.options.transport(args)
        if (args[2] !== 'set') return response
        return { ...response, resume_binding: { ...response.resume_binding, ...invalid } }
      },
    })
    bridge.update(f.manager, true)
    await bridge.idle()
    bridge.stop()
    await bridge.idle()
  }
  assert.equal(f.clears.length, 0)
  assert.equal(f.feedCalls.length, 0)
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
})

test('indexes Auto metadata and provider/model provenance from the selected native branch', async t => {
  const f = await fixture(t)
  f.setBranch([
    { type: 'message', message: { role: 'assistant', provider: 'openai', model: 'gpt-6.1-sol' } },
    { type: 'model_change', provider: 'github-copilot', modelId: 'claude-fable-5' },
    { type: 'model_change', provider: 'github-copilot', modelId: 'claude-fable-5' },
    { type: 'model_change', provider: 'github-copilot\ninvalid', modelId: 'ignored' },
    { type: 'custom', customType: GSD_AUTO_MODE, data: { version: 1 } },
  ])
  assert.deepEqual(cmuxVaultModes(f.manager), ['auto'])
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const [record] = await f.metadata()
  assert.deepEqual(record.data.gsdModes, ['auto'])
  assert.deepEqual(record.data.gsdModels, [
    { provider: 'github-copilot', modelId: 'claude-fable-5' },
    { provider: 'openai', modelId: 'gpt-6.1-sol' },
  ])
  assert.equal(record.data.title, 'GSD — Auto · github-copilot:claude-fable-5 + openai:gpt-6.1-sol')
})

test('guarded socket clear uses verified RPC, numeric generation and bounded safe failure', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const socketPath = join(f.root, 'cmux.sock')
  const received: unknown[] = []
  let mode = 'ok'
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', data => {
      const request = JSON.parse(String(data))
      received.push(request)
      if (mode === 'hang') return
      if (mode === 'bad') return socket.end('garbage\n')
      if (mode === 'oversized') return socket.end('x'.repeat(70 * 1024))
      socket.end(JSON.stringify({ id: request.id, ok: true, result: { cleared: true } }) + '\n')
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const params: CmuxVaultClearRequest = {
    workspace_id: 'workspace-uuid', surface_id: 'surface-uuid',
    checkpoint_id: '/actual 日本語/session.jsonl', source: 'agent-hook',
    expected_updated_at: 1793615000.123,
  }
  assert.deepEqual(await clearCmuxVaultBinding(socketPath, params), { cleared: true })
  assert.equal(CMUX_VAULT_DEFAULT_SOCKET_PATH, '/tmp/cmux.sock', 'cmux protocol default must not follow TMPDIR')
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, CMUX_SOCKET_PATH: socketPath },
    clearBinding: undefined,
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  bridge.stop()
  await bridge.idle()
  assert.equal((f.feedCalls.at(-1)?.event as { hook_event_name: string }).hook_event_name, 'SessionEnd',
    'bridge cleanup uses the explicit socket override')
  assert.deepEqual(received[0], {
    id: (received[0] as { id: string }).id, method: 'surface.resume.clear', params,
  })
  mode = 'bad'
  await assert.rejects(clearCmuxVaultBinding(socketPath, params))
  mode = 'oversized'
  await assert.rejects(clearCmuxVaultBinding(socketPath, params))
  mode = 'hang'
  const start = Date.now()
  await assert.rejects(clearCmuxVaultBinding(socketPath, params))
  assert.ok(Date.now() - start < 5000)
  await assert.rejects(clearCmuxVaultBinding(join(f.root, 'missing.sock'), params))
})

test('graceful shutdown keeps the durable exact-resume binding for a later cmux restore', async t => {
	const f = await fixture(t)
	const handlers = new Map<string, Function>()
	const waiters: Array<() => void> = []
	await createCmuxVaultExtension({
		...f.options,
		transport: async args => {
			const result = await f.options.transport(args)
			if (args[0] === 'rpc' && args[1] === 'feed.push') waiters.shift()?.()
			return result
		},
	})({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never)
	const ctx = { sessionManager: f.manager, hasUI: true }
	const first = new Promise<void>(resolve => waiters.push(resolve))
	assert.equal(handlers.get('session_start')!({}, ctx), undefined)
	await first
	await handlers.get('session_shutdown')!()
	// Shutdown ends live presence only. The exact-resume binding is the durable
	// contract that Reopen Closed / cmux restore needs, so it must survive quit.
	assert.equal(f.clears.length, 0, 'shutdown must not delete the durable resume binding')
})

test('an unsaved-session invalidation queued behind an in-flight publish still clears on shutdown', async t => {
  const f = await fixture(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let blocked!: () => void
  const sawBlockedSet = new Promise<void>(resolve => { blocked = resolve })
  let firstSet = true
  const bridge = new CmuxVaultBridge({
    ...f.options,
    transport: async args => {
      if (args[2] === 'set' && firstSet) { firstSet = false; blocked(); await gate }
      return f.options.transport(args)
    },
  })
  bridge.update(f.manager, true)
  await sawBlockedSet
  // Refresh is in flight. The session becomes unsaved and is queued behind it, then
  // shutdown arrives before the publish is released.
  f.setSession(undefined)
  bridge.update(f.manager, true)
  bridge.stop()
  release()
  await bridge.idle()
  assert.equal(f.clears.length, 1, 'the queued unsaved invalidation is not erased by shutdown')
})

test('an opt-out queued behind an in-flight publish still clears its newly accepted binding', async t => {
  const f = await fixture(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let blocked!: () => void
  const sawBlockedSet = new Promise<void>(resolve => { blocked = resolve })
  let resume = true
  let firstSet = true
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    transport: async args => {
      if (args[2] === 'set' && firstSet) { firstSet = false; blocked(); await gate }
      return f.options.transport(args)
    },
    getPreferences: async () => ({ enabled: true, vault: false, resume }),
  })
  bridge.update(f.manager, true)
  await sawBlockedSet
  // The publish is still in flight. Resume is turned off, the change is queued,
  // shutdown arrives, and only then is the publish released.
  resume = false
  bridge.update(f.manager, true, true)
  bridge.stop()
  release()
  await bridge.idle()
  assert.equal(f.clears.length, 1, 'the binding accepted by the in-flight publish is cleared by the opt-out')
})

test('shutdown requested after drain resolves but before the wrapper finally still sends SessionEnd', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  // Intercept the drain the bridge runs, so shutdown can be requested in the exact
  // window after the original drain resolves and before the running wrapper finishes.
  const internal = bridge as unknown as { drain: () => Promise<void> }
  const originalDrain = internal.drain.bind(bridge)
  let requested = false
  internal.drain = async () => {
    await originalDrain()
    if (!requested) {
      requested = true
      bridge.stop()
    }
  }
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(requested, true, 'shutdown was requested after the original drain resolved')
  assert.deepEqual(presenceEvents(f).at(-1), 'SessionEnd', 'the late shutdown is still drained')
})

test('a successor never takes over another session binding, even when its file still exists', async t => {
  const f = await fixture(t)
  const a = new CmuxVaultBridge(f.options)
  a.update(f.manager, true)
  await a.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1, 'A publishes its binding')
  a.stop()
  await a.idle()
  // B starts on the same surface. A's file still exists, but nothing proves A ended,
  // so B must not overwrite the binding (a live owner would otherwise be broken).
  const bPath = join(f.cwd, 'successor.jsonl')
  await writeFile(bPath, 'successor conversation')
  f.setSession(bPath)
  const b = new CmuxVaultBridge(f.options)
  b.update(f.manager, true)
  await b.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1, 'B does not take over A binding')
  b.stop()
  await b.idle()
})

test('shell payload preserves hostile, empty and quoted literals without injection', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const marker = join(f.cwd, 'injected')
  const hostile = `'; touch "${marker}"; echo ' $(touch "${marker}") \`touch "${marker}"\` $HOME\n*?\\`
  f.options.home = join(f.home, hostile)
  f.options.launcher = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({args: process.argv.slice(1), home: process.env.GSD_HOME}))', '', hostile, "single'quote"]
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const request = f.calls[0]
  const command = request[request.indexOf('--shell') + 1]
  const output = await new Promise<string>((resolve, reject) => {
    execFile('/bin/sh', ['-c', command], (error, stdout) => error ? reject(error) : resolve(stdout))
  })
  assert.deepEqual(JSON.parse(output), {
    args: ['', hostile, "single'quote", '--resume-exact', f.manager.getSessionFile(), f.manager.getSessionId()],
    home: f.options.home,
  })
  await assert.rejects(stat(marker), { code: 'ENOENT' })
  bridge.stop()
  await bridge.idle()
})

test('only mocked native signed scope grants automatic restore and matching republish preserves it', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge({ ...f.options, getPreferences: async () => ({ enabled: true, vault: true, resume: true }) })
  bridge.update(f.manager, true)
  await bridge.idle()
  const show = async () => (await f.options.transport(['surface', 'resume', 'show'])).resume_binding
  assert.equal((await show())?.auto_resume, false)
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal((await show())?.auto_resume, false)
  f.approveNative()
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal((await show())?.auto_resume, true)
  assert.ok(f.calls.slice(1).every(args => args.includes('--if-updated-at')))
  bridge.stop()
  await bridge.idle()
  assert.equal((await show())?.auto_resume, true, 'shutdown retains native approval and durable binding')
})

for (const change of ['cwd', 'home', 'command'] as const) {
  test(`native signed scope does not follow changed ${change}`, async t => {
    const f = await fixture(t)
    const bridge = new CmuxVaultBridge({ ...f.options, getPreferences: async () => ({ enabled: true, vault: true, resume: true }) })
    bridge.update(f.manager, true)
    await bridge.idle()
    f.approveNative()
    bridge.stop()
    await bridge.idle()
    const args = [...f.calls[0]]
    args.splice(args.indexOf('--if-unbound'), 1, '--if-checkpoint-id', f.manager.getSessionFile()!, '--if-source', 'gsd', '--if-updated-at', '101')
    if (change === 'cwd') args[args.indexOf('--cwd') + 1] += '/changed'
    else args[args.indexOf('--shell') + 1] = args[args.indexOf('--shell') + 1].replace(change === 'home' ? f.home : '/absolute/node', 'changed')
    const result = await f.options.transport(args)
    assert.equal(result.resume_binding?.auto_resume, false)
  })
}

test('same-session legacy structured binding migrates using its observed source and generation', async t => {
  const f = await fixture(t)
  f.setBinding({ ...legacyBinding(f), auto_resume: false })
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][f.calls[0].indexOf('--if-source') + 1], 'agent-hook')
  assert.equal(f.calls[0][f.calls[0].indexOf('--if-updated-at') + 1], '101')
  const binding = (await f.options.transport(['surface', 'resume', 'show'])).resume_binding
  assert.equal(binding?.source, 'gsd')
  assert.equal(binding?.launch_command, null)
  f.setSession(undefined)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.clears[0].source, 'gsd')
})

for (const initial of [true, false]) {
  test(`native CAS preserves after-show competitor on ${initial ? 'initial absence' : 'owned replacement'}`, async t => {
    const f = await fixture(t)
    let race = initial
    let competitor: Record<string, unknown> | undefined
    const bridge = new CmuxVaultBridge({ ...f.options, transport: async args => {
      if (args[2] === 'set' && race) {
        competitor = { ...automaticBinding(f), source: 'user', updated_at: 900, command: 'manual command' }
        f.setBinding(competitor)
      }
      return f.options.transport(args)
    } })
    bridge.update(f.manager, true)
    await bridge.idle()
    if (!initial) {
      race = true
      bridge.update(f.manager, true, true)
      await bridge.idle()
    }
    assert.equal(f.calls.length, initial ? 1 : 2, 'no unguarded retry')
    assert.deepEqual((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, competitor)
    bridge.stop()
    await bridge.idle()
    assert.equal(f.clears.length, 0)
  })
}

for (const capability of ['missing', 'malformed', 'error', 'query-error'] as const) {
  test(`fails closed with ${capability} CAS discovery`, async t => {
    const f = await fixture(t)
    const bridge = new CmuxVaultBridge({ ...f.options, transport: async args => {
      if (args[0] === 'rpc' && args[1] === 'system.capabilities') {
        if (capability === 'query-error') throw new Error('redacted')
        if (capability === 'error') return { ok: false, methods: ['surface.resume.conditional_set.v1'] }
        return { methods: capability === 'missing' ? [] : ['surface.resume.conditional_set.v1', null] }
      }
      return f.options.transport(args)
    } })
    bridge.update(f.manager, true)
    await bridge.idle()
    bridge.update(f.manager, true, true)
    await bridge.idle()
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.clears, [])
  })
}

test('unsupported conditional CLI fails without retry or unguarded fallback', async t => {
  const f = await fixture(t)
  const sets: string[][] = []
  const bridge = new CmuxVaultBridge({ ...f.options, transport: async args => {
    if (args[2] === 'set') { sets.push(args); throw new Error('unknown --if-unbound') }
    return f.options.transport(args)
  } })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(sets.length, 1)
  assert.ok(sets[0].includes('--if-unbound'))
  assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding, null)
  bridge.stop()
  await bridge.idle()
})


function legacyBinding(f: Awaited<ReturnType<typeof fixture>>): Record<string, unknown> {
  const argv = ['env', `GSD_HOME=${f.home}`, ...f.options.launcher, '--resume-exact', f.manager.getSessionFile()!, f.manager.getSessionId()]
  return { ...automaticBinding(f), source: 'agent-hook',
    command: argv.map(value => `'${value.replace(/'/g, "'\\''")}'`).join(' '),
    launch_command: { executable_path: 'env', arguments: argv, working_directory: f.cwd, environment: null },
  }
}

test('legacy opt-out clears with the observed legacy source, never the publication source', async t => {
  const f = await fixture(t)
  f.setBinding(legacyBinding(f))
  const bridge = new CmuxVaultBridge({ ...f.options, env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async () => ({ enabled: false, vault: false, resume: false }),
  })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.clears.length, 1)
  assert.equal(f.clears[0].source, 'agent-hook')
  assert.equal(f.clears[0].expected_updated_at, 101)
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 0)
})

test('legacy adoption rejects changed command, captured cwd/env, target, ID, path and malformed generation', async t => {
  const f = await fixture(t)
  const base = legacyBinding(f)
  for (const overrides of [
    { command: 'gsd --continue' },
    { checkpoint_id: '/predecessor/session.jsonl' },
    { cwd: '/foreign' },
    { source: 'user' },
    { updated_at: NaN },
    { updated_at: '101' },
    { updated_at: undefined },
    { launch_command: { ...(base.launch_command as object), arguments: ['env', 'gsd', '--resume-exact', f.manager.getSessionFile(), 'other-id'] } },
    { launch_command: { ...(base.launch_command as object), working_directory: '/foreign' } },
    { launch_command: { ...(base.launch_command as object), environment: { GSD_HOME: '/foreign' } } },
  ]) {
    f.setBinding({ ...base, ...overrides, auto_resume: false })
    const bridge = new CmuxVaultBridge(f.options)
    bridge.update(f.manager, true)
    await bridge.idle()
    bridge.stop()
    await bridge.idle()
  }
  f.setBinding({ ...base, auto_resume: false })
  const bridge = new CmuxVaultBridge({ ...f.options, transport: async args => {
    const result = await f.options.transport(args)
    return args[2] === 'show' ? { ...result, workspace_id: 'foreign', workspace_ref: 'workspace:foreign' } : result
  } })
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.clears, [])
})

test('source and command changes on an owned generation block replacement and source-fenced clear', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge(f.options)
  bridge.update(f.manager, true)
  await bridge.idle()
  const previous = (await f.options.transport(['surface', 'resume', 'show'])).resume_binding!
  f.setBinding({ ...previous, command: 'foreign command' })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1)
  f.setBinding({ ...previous, source: 'user' })
  f.setSession(undefined)
  bridge.update(f.manager, true)
  await bridge.idle()
  assert.equal(f.clears[0].source, 'gsd')
  assert.equal((await f.options.transport(['surface', 'resume', 'show'])).resume_binding?.source, 'user')
})

test('publication diagnostics are bounded and never echo native errors or commands', async t => {
  const f = await fixture(t)
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  const bridge = new CmuxVaultBridge({ ...f.options, transport: async args => {
    if (args[2] === 'set') throw new Error('PRIVATE_TRANSCRIPT GSD_HOME=secret')
    return f.options.transport(args)
  } })
  for (let i = 0; i < 5; i++) {
    bridge.update(f.manager, true, true)
    await bridge.idle()
  }
  assert.equal(warnings.length, 1)
  assert.equal(JSON.stringify(warnings).includes('PRIVATE_TRANSCRIPT'), false)
  assert.equal(JSON.stringify(warnings).includes('secret'), false)
  assert.equal(JSON.stringify(warnings).includes(f.home), false)
})


test('set confirmation must retain the exact workspace and surface observed before CAS', async t => {
  const f = await fixture(t)
  for (const target of [{ workspace_id: 'other-workspace' }, { surface_id: 'other-surface' }]) {
    f.setBinding(null)
    const bridge = new CmuxVaultBridge({ ...f.options, transport: async args => {
      const result = await f.options.transport(args)
      return args[2] === 'set' ? { ...result, ...target } : result
    } })
    bridge.update(f.manager, true)
    await bridge.idle()
    bridge.stop()
    await bridge.idle()
  }
  assert.deepEqual(f.clears, [])
  assert.deepEqual(f.feedCalls, [])
  await assert.rejects(readdir(join(f.home, 'cmux', 'vault')), { code: 'ENOENT' })
})

test('an external clear of an owned binding republishes on the next refresh', async t => {
  const f = await fixture(t)
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async () => ({ enabled: true, vault: true, resume: true }),
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1)
  // Simulate cmux removing the binding outside GSD: show now reports nothing.
  f.setObservedBinding?.(undefined)
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 2,
    'an empty show must drop the stale owned binding so publication can resume')
  bridge.stop()
  await bridge.idle()
})

test('disabling resume while capability discovery fails still drops a persisted automatic binding', async t => {
  const f = await fixture(t)
  f.setBinding(automaticBinding(f))
  f.failCapabilityDiscovery()
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
    getPreferences: async () => ({ enabled: true, vault: true, resume: false }),
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.clears.length, 1,
    'resume-off startup must clear the exact persisted auto_resume binding even if discovery fails')
  bridge.stop()
  await bridge.idle()
})

test('external clear ends old Vault presence before publishing another session', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const sessionAFile = f.manager.getSessionFile()
  // cmux clears the binding outside GSD; assert the observed state is actually empty.
  f.setObservedBinding(undefined)
  const sessionB = join(f.root, 'session-b.jsonl')
  await writeFile(sessionB, 'session b\n')
  f.setSession(sessionB, 'session-b-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const events = f.feedCalls.map(call => ({
    event: (call.event as { hook_event_name: string }).hook_event_name,
    session: (call.event as { session_id?: string }).session_id,
  }))
  // Exact sequence: A starts, A ends, then B starts. Anything else is a regression.
  assert.deepEqual(events.map(e => e.event), ['SessionStart', 'SessionEnd', 'SessionStart'])
  assert.equal(events[0].session, sessionAFile, 'first start must be session A')
  assert.equal(events[1].session, sessionAFile, 'the end must name session A')
  assert.equal(events[2].session, sessionB, 'the final start must be session B')
  bridge.stop()
  await bridge.idle()
})

test('a failed SessionEnd keeps presence pending so a later cleanup can retry it', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // cmux clears our binding; the next refresh sees it and must send SessionEnd. Delivery fails.
  f.setObservedBinding(undefined)
  f.failFeed(true)
  const sessionB = join(f.root, 'session-b-pending.jsonl')
  await writeFile(sessionB, 'session b\n')
  f.setSession(sessionB, 'session-b-pending-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // Transport recovers: the next lifecycle step must retry the still-pending SessionEnd.
  f.failFeed(false)
  bridge.stop()
  await bridge.idle()
  const ends = f.feedCalls.filter(c => (c.event as { hook_event_name?: string }).hook_event_name === 'SessionEnd')
  assert.ok(ends.length >= 2, 'a failed SessionEnd must be retried after transport recovers, not silently dropped')
})

test('a pending SessionEnd is retried on an ordinary refresh of the next session, not only on shutdown', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // A's SessionEnd must FAIL. The external clear makes the next publish end A; the transport
  // is down for exactly that end, so it stays pending.
  f.setObservedBinding(undefined)
  f.failFeedFor('SessionEnd', true)
  const sessionB = join(f.root, 'session-b-refresh.jsonl')
  await writeFile(sessionB, 'session b\n')
  f.setSession(sessionB, 'session-b-refresh-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // Record the attempts made before recovery; only attempts AFTER recovery prove a retry.
  const endAttemptsBeforeRecovery = f.feedCalls.filter(c => (c.event as { hook_event_name?: string }).hook_event_name === 'SessionEnd').length
  // Transport recovers for SessionEnd. A plain refresh of B (no shutdown, no handoff) must flush A's end.
  f.failFeedFor('SessionEnd', false)
  f.setSession(sessionB, 'session-b-refresh-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const endAttemptsAfterRecovery = f.feedCalls.filter(c => (c.event as { hook_event_name?: string }).hook_event_name === 'SessionEnd').length
  assert.ok(endAttemptsAfterRecovery > endAttemptsBeforeRecovery,
    'an ordinary refresh after recovery must make a new SessionEnd attempt for A (not only at shutdown)')
  bridge.stop()
  await bridge.idle()
})


test('resume off with local ownership never adopts or clears a newer same-conversation generation', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  // Publish our own binding (generation N, the value cmux recorded for our set).
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // Another publisher replaces the binding with a complete newer generation (999) for the same conversation.
  // The successor must match the bridge's own shell identity exactly; only the generation differs.
  const ownCommand = (bridge as unknown as { shellCommand(identity: { path: string; cwd: string; id: string }): string }).shellCommand({ path: f.manager.getSessionFile()!, cwd: f.cwd, id: f.manager.getSessionId() })
  const successor: Record<string, unknown> = { kind: 'gsd', source: 'gsd', checkpoint_id: f.manager.getSessionFile(), cwd: f.cwd, updated_at: 999, auto_resume: true, command: ownCommand, launch_command: null, environment: null }
  f.setBinding(successor)
  const setsBefore = f.calls.length
  // Resume is switched off while Vault stays on: a refresh must not write over the successor.
  f.setPreferences({ enabled: true, vault: true, resume: false })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const newSets = f.calls.slice(setsBefore)
  const ownedWriteAgainstSuccessor = newSets.some(args => args.includes('--if-checkpoint-id') && args[args.indexOf('--if-updated-at') + 1] === '999')
  const clearedSuccessor = f.clears.some(c => c.expected_updated_at === 999)
  assert.equal(clearedSuccessor, false, 'a newer same-conversation generation owned by another publisher must not be cleared')
  assert.equal(ownedWriteAgainstSuccessor, false, 'the bridge must not adopt the successor generation as its own write target')
  bridge.stop()
  await bridge.idle()
})


test('resume off with Vault on ends the live presence before the same-generation persisted cleanup clears it', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  // Publish our binding, then grant native approval so it becomes an automatic restore binding.
  bridge.update(f.manager, true, true)
  await bridge.idle()
  f.approveNative()
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const show = async () => (await f.options.transport(['surface', 'resume', 'show'])).resume_binding
  assert.equal((await show())?.auto_resume, true, 'precondition: the owned binding is an automatic restore binding')
  const endsBefore = f.feedCalls.filter(c => (c.event as { hook_event_name?: string }).hook_event_name === 'SessionEnd').length
  const clearsBefore = f.clears.length
  // Resume is switched off while Vault stays on; the cleanup clears the same generation.
  f.setPreferences({ enabled: true, vault: true, resume: false })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const endsAfter = f.feedCalls.filter(c => (c.event as { hook_event_name?: string }).hook_event_name === 'SessionEnd').length
  assert.ok(f.clears.length > clearsBefore, 'precondition: the owned automatic binding is cleared')
  assert.equal(endsAfter - endsBefore, 1, 'the live presence must receive exactly one SessionEnd before its ownership is dropped')
  bridge.stop()
  await bridge.idle()
})

test('a successor SessionStart is not announced while the predecessor SessionEnd is unaccepted', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // Switch A to B while A's end cannot be delivered.
  const sessionB = join(f.root, 'session-b-g1.jsonl')
  await writeFile(sessionB, 'session b\n')
  f.failFeedFor('SessionEnd', true)
  f.setSession(sessionB, 'session-b-g1-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const events = f.feedCalls.map(c => (c.event as { hook_event_name?: string }).hook_event_name)
  const startsForB = f.feedCalls.filter(c => (c.event as { hook_event_name?: string; session_id?: string }).hook_event_name === 'SessionStart' && (c.event as { session_id?: string }).session_id === sessionB).length
  assert.equal(events.includes('SessionEnd') && startsForB, 0,
    'B must not be announced as live while A presence has not ended (events: ' + JSON.stringify(events) + ')')
  bridge.stop()
  await bridge.idle()
})

test('a gated successor SessionStart is announced once the predecessor end is finally accepted', async t => {
  const f = await fixture(t)
  f.setPreferences({ enabled: true, vault: true, resume: true })
  const bridge = new CmuxVaultBridge({
    ...f.options,
    env: { ...f.env, GSD_CMUX_VAULT: undefined },
  })
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const sessionB = join(f.root, 'session-b-g1-recover.jsonl')
  await writeFile(sessionB, 'session b\n')
  f.failFeedFor('SessionEnd', true)
  f.setSession(sessionB, 'session-b-g1-recover-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  // Transport recovers; a plain refresh of B must now end A and then announce B.
  f.failFeedFor('SessionEnd', false)
  f.setSession(sessionB, 'session-b-g1-recover-id')
  bridge.update(f.manager, true, true)
  await bridge.idle()
  const startsForB = f.feedCalls.filter(c => (c.event as { hook_event_name?: string; session_id?: string }).hook_event_name === 'SessionStart' && (c.event as { session_id?: string }).session_id === sessionB).length
  assert.ok(startsForB >= 1, 'B must eventually be announced after A end is accepted')
  bridge.stop()
  await bridge.idle()
})
