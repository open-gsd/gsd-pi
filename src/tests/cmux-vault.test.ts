import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { SessionManager } from '../../packages/pi-coding-agent/src/core/session-manager.ts'
import {
  GSD_WORKFLOW_CONTEXT, GSD_DELEGATION_CONTEXT, recordWorkflowContext, recordDelegation,
} from '../resources/extensions/shared/gsd-session-metadata.ts'
import {
  CmuxVaultBridge,
  CMUX_VAULT_MAX_PENDING_SESSIONS,
  CMUX_VAULT_DEFAULT_SOCKET_PATH,
  clearCmuxVaultBinding,
  cmuxVaultEnabled,
  cmuxVaultConfigured,
  cmuxVaultModes,
  createCmuxVaultExtension,
  hasManagedCmuxBridge,
  runCmuxVaultCommand,
  type CmuxVaultClearRequest,
  type CmuxVaultSession,
} from '../cmux-vault.ts'

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
  let clock = 100
  const result = () => ({
    workspace_id: 'workspace-uuid', surface_id: 'surface-uuid', cleared: false, resume_binding: binding,
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
    getPreferences: async () => ({ enabled: true, vault: true }),
    transport: async (args: string[]) => {
      allCalls.push(args)
      if (args[0] === 'rpc') {
        feedCalls.push(JSON.parse(args[2]))
        return { accepted: true }
      }
      if (args[2] === 'set') {
        calls.push(args)
        const option = (name: string) => args[args.indexOf(name) + 1]
        binding = {
          kind: 'gsd', source: 'agent-hook', checkpoint_id: option('--checkpoint-id'),
          cwd: option('--cwd'), auto_resume: false, updated_at: ++clock,
          launch_command: { arguments: args.slice(args.indexOf('--') + 1) },
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
      const cleared = binding?.checkpoint_id === params.checkpoint_id && binding?.updated_at === params.expected_updated_at
      if (cleared) binding = null
      return { ...result(), cleared }
    },
  }
  return {
    root, home, cwd, calls, allCalls, clears, feedCalls, env, options, manager,
    setBinding: (value: Record<string, unknown> | null) => { binding = value },
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
  assert.equal(f.allCalls.length, 0)
  settings = { enabled: true, vault: true }
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls[0][2], 'set')
  settings = { enabled: false, vault: true }
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.clears.length, 1)
  assert.ok(projects.length >= 3)
  assert.ok(projects.every(cwd => cwd === f.cwd))
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
    '--source', 'agent-hook', '--cwd', f.cwd, '--',
    'env', `GSD_HOME=${f.home}`, ...f.options.launcher, '--session', f.manager.getSessionFile(),
  ]])
  const [record] = await f.metadata()
  assert.deepEqual(record.data, {
    sessionId: f.manager.getSessionFile(), gsdSessionId: 'runtime-session-id', cwd: f.cwd, title: 'GSD', gsdModes: [],
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
      if (args[0] === 'rpc') published()
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
    '--checkpoint-id', second, '--source', 'agent-hook',
  ])
  bridge.stop()
  await bridge.idle()
  assert.equal(f.calls.length, 3, 'already-cleared binding is not cleared twice')
  assert.deepEqual(f.feedCalls.map(call => (call.event as { hook_event_name: string }).hook_event_name),
    ['SessionStart', 'SessionEnd', 'SessionStart', 'SessionEnd'])
  assert.deepEqual(f.clears, [{
    workspace_id: 'workspace-uuid', surface_id: 'surface-uuid', checkpoint_id: second,
    source: 'agent-hook', expected_updated_at: 102,
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

test('disabled, outside cmux, child, noninteractive and external-owner sessions do nothing', async t => {
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
  assert.deepEqual(f.allCalls, [])
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
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 2)
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
  assert.ok(f.calls.length <= 2)
  assert.equal(f.calls.at(-1)?.[2], 'clear')
})

test('extension factory attaches supported post-switch lifecycle events without reading event content', async t => {
  const f = await fixture(t)
  const handlers = new Map<string, Function>()
  const factory = createCmuxVaultExtension(f.options)
  await factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never)
  assert.deepEqual([...handlers.keys()], ['session_start', 'session_tree', 'turn_end', 'agent_end', 'session_shutdown'])
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
      if (args[0] === 'rpc') waiters.shift()?.()
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
  assert.equal(f.clears.length, 1)
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
      if (args[0] === 'rpc') waiters.shift()?.()
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
  await handlers.get('session_shutdown')!()
})

test('real subprocess transport preserves argv and rejects malformed output, failure and timeout', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const cli = join(f.root, 'cmux')
  await writeFile(cli, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('hang')) setTimeout(() => {}, 10000);
else if (args.includes('bad-json')) process.stdout.write('not json');
else if (args.includes('fail')) process.exit(1);
else process.stdout.write(JSON.stringify({args}));
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
    const bridge = new CmuxVaultBridge({ ...f.options, transport: async () => response })
    bridge.update(f.manager, true)
    await bridge.idle()
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
    kind: 'gsd', source: 'agent-hook', checkpoint_id: f.manager.getSessionFile(),
    updated_at: 999,
  }
  f.setBinding(replacement)
  bridge.update(f.manager, true, true)
  await bridge.idle()
  assert.equal(f.calls.length, 1, 'preflight refuses replacement ownership')
  bridge.stop()
  await bridge.idle()
  assert.equal(f.clears[0].expected_updated_at, 101, 'clear fences the exact accepted generation')
  const probe = await f.options.transport(['surface', 'resume', 'show'])
  assert.equal(probe.resume_binding, replacement)
})

test('effective set responses must retain the requested identity, argv and manual-only capability', async t => {
  const f = await fixture(t)
  for (const invalid of [
    { auto_resume: true },
    { kind: 'pi' },
    { checkpoint_id: '/retained/other-session.jsonl' },
    { updated_at: 'not-a-generation' },
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
