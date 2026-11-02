import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import {
  CmuxVaultBridge,
  clearCmuxVaultBinding,
  cmuxVaultEnabled,
  createCmuxVaultExtension,
  hasManagedCmuxBridge,
  runCmuxVaultCommand,
  type CmuxVaultClearRequest,
} from '../cmux-vault.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gsd-vault-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'custom home 日本語')
  const cwd = join(root, 'project $(); spaces')
  await mkdir(cwd)
  let path: string | undefined = join(cwd, 'actual session.jsonl')
  let id = 'runtime-session-id'
  await writeFile(path, 'private conversation must never be copied\n')
  const manager = {
    getSessionId: () => id,
    getSessionFile: () => path,
    getCwd: () => cwd,
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
  for (const key of Object.keys(env)) {
    assert.equal(cmuxVaultEnabled({ ...env, [key]: '' }, 42), false, key)
  }
  assert.equal(cmuxVaultEnabled(env, 43), false, 'children inherit a different owner pid')
  assert.equal(cmuxVaultEnabled({ ...env, GSD_CMUX_VAULT_EXTERNAL_BRIDGE: '1' }, 42), false)
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
    sessionId: f.manager.getSessionFile(), gsdSessionId: 'runtime-session-id', cwd: f.cwd, title: 'GSD',
  })
  assert.equal(record.mode, 0o600)
  assert.equal((await stat(join(f.home, 'cmux', 'vault'))).mode & 0o777, 0o700)
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
  assert.deepEqual([...handlers.keys()], ['session_start', 'agent_end', 'session_shutdown'])
  const ctx = { sessionManager: f.manager, hasUI: false }
  assert.doesNotThrow(() => handlers.get('agent_end')!({ messages: ['secret'] }, ctx))
  await handlers.get('session_shutdown')!()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, [])
})

test('real subprocess transport preserves argv and rejects malformed output, failure and timeout', async t => {
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
  // Exercise an inherited owner marker in a real child without cmux or history.
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [
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

test('guarded socket clear uses verified RPC, numeric generation and bounded safe failure', async t => {
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
