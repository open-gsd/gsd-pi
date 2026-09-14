import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(pluginDir, '../..');
const openclaw = process.env.OPENCLAW_BIN;

// Exercise automatic synchronization in the installed artifact. No model is called.
test('packed plugin automatically synchronizes projects, TaskFlow and Workboard from events', {
  timeout: 180_000,
}, async (t) => {
  assert.ok(openclaw, 'Set OPENCLAW_BIN to OpenClaw 2026.9.2 or newer');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gsd-openclaw-host-')));
  const stateDir = join(root, 'host');
  const repo = join(root, 'project');
  const configPath = join(stateDir, 'openclaw.json');
  const token = randomUUID();
  // Deliberately omit provider credentials, user config, and ambient channels.
  const env = {
    PATH: process.env.PATH,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    GSD_HOME: join(root, 'gsd-home'),
    NO_COLOR: '1',
  };
  let gateway;
  let logs = '';
  async function stop() {
    if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
    const exited = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    const timer = setTimeout(() => gateway.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const run = (file, args, options = {}) => exec(file, args, {
    env, cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  const cli = (args) => run(openclaw, args);
  await mkdir(repo);
  await mkdir(stateDir);
  await run('git', ['init', '--initial-branch=main', repo]);
  await writeFile(join(repo, 'README.md'), 'Native host contract fixture\n');
  await writeFile(join(repo, '.gitignore'), '.gsd/\n');
  await run('git', ['-C', repo, 'add', 'README.md', '.gitignore']);
  await run('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: 'local', auth: { mode: 'token', token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: repo, model: { primary: 'anthropic/claude-sonnet-4-5' }, heartbeat: { every: '0m' } } },
    plugins: { allow: ['open-gsd-openclaw', 'workboard'], entries: { workboard: { enabled: true } } },
    mcp: { servers: { gsd: {
      command: process.execPath,
      args: [join(repoDir, 'packages/mcp-server/bin/gsd-mcp-server.js')],
      env: { GSD_CLI_PATH: join(repoDir, 'dist/loader.js'), GSD_HOME: env.GSD_HOME },
    } } },
  }));
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: pluginDir })).stdout)[0];
  await cli(['plugins', 'install', `npm-pack:${join(root, packed.filename)}`, '--force', '--accept-capabilities']);
  const inspected = JSON.parse((await cli(['plugins', 'inspect', 'open-gsd-openclaw', '--runtime', '--json'])).stdout);
  assert.equal(inspected.plugin.status, 'loaded');
  assert.equal(inspected.plugin.mcpServers.gsd.command, 'gsd-mcp-server');
  assert.ok(inspected.services.some((service) => (service.id ?? service) === 'gsd-project-sync'));
  assert.ok(inspected.install.acceptedSurface.skills.includes('./skills'));
  const probe = JSON.parse((await cli(['mcp', 'doctor', 'gsd', '--probe', '--json'])).stdout);
  assert.equal(probe.ok, true);
  assert.equal(probe.servers.find((server) => server.name === 'gsd')?.ok, true);

  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const configured = JSON.parse(await readFile(configPath, 'utf8'));
  configured.gateway.port = port;
  await writeFile(configPath, JSON.stringify(configured));
  async function rpc(method, params = {}) {
    const { stdout } = await cli(['gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--url', `ws://127.0.0.1:${port}`, '--token', token]);
    return JSON.parse(stdout);
  }
  async function start() {
    gateway = spawn(openclaw, ['gateway', 'run', '--port', String(port), '--bind', 'loopback', '--tailscale', 'off'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', (data) => { logs += data; });
    gateway.stderr.on('data', (data) => { logs += data; });
    for (let attempt = 0; attempt < 12; attempt++) {
      try { await rpc('health'); return; } catch (error) {
        if (gateway.exitCode !== null || gateway.signalCode !== null || attempt === 11) {
          throw new Error(`Isolated gateway failed: ${logs}`, { cause: error });
        }
        await delay(250);
      }
    }
  }
  await start();
  const project = await rpc('projects.register', { path: repo, name: 'GSD fixture' });
  const listed = await rpc('projects.list');
  assert.equal(project.repoRoot, repo);
  assert.ok(listed.projects.some((entry) => entry.id === project.id));
  await assert.rejects(rpc('projects.register', { path: join(root, 'missing'), name: 'Missing' }));
  const worktree = await rpc('worktrees.create', { repoRoot: repo, name: 'gsd-fixture', baseRef: 'main' });
  assert.ok(worktree.path && worktree.path !== repo);
  assert.equal((await run('git', ['-C', worktree.path, 'branch', '--show-current'])).stdout.trim(), 'openclaw/gsd-fixture');
  assert.equal(await readFile(join(worktree.path, 'README.md'), 'utf8'), 'Native host contract fixture\n');
  await assert.rejects(rpc('worktrees.create', { repoRoot: repo, name: 'bad-ref', baseRef: 'missing-ref' }));
  await mkdir(join(worktree.path, '.gsd'));
  await writeFile(join(worktree.path, '.gsd/STATE.md'), '# GSD State\n\n**Active Milestone:** M001: Native worktree\n**Phase:** execution\n');
  const progress = JSON.parse((await run(process.execPath, [join(repoDir, 'dist/loader.js'), 'read', 'progress', '--json', '--project', worktree.path])).stdout);
  assert.equal(progress.integration_version, 1);
  assert.equal(progress.data.activeMilestone.id, 'M001');

  // A newly selected legacy checkout is discovered from the host session event.
  await rpc('sessions.create', { key: 'agent:main:gsd-fixture', cwd: worktree.path });
  async function eventually(check) {
    let last;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { const value = await check(); if (value) return value; } catch (error) { last = error; }
      await delay(100);
    }
    throw new Error(`Automatic synchronization did not converge: ${logs}`, { cause: last });
  }
  const getCards = async () => (await rpc('workboard.cards.list')).cards.filter((card) => card.labels.includes('gsd'));
  const getFlows = async () => {
    const result = JSON.parse((await cli(['tasks', 'flow', 'list', '--json'])).stdout);
    return (result.flows ?? result).filter((flow) => flow.controllerId === 'open-gsd-openclaw.projects');
  };
  const card = await eventually(async () => (await getCards()).find((entry) => entry.status === 'running'));
  assert.equal(card.metadata.automation.workspace.path, worktree.path);
  const flow = await eventually(async () => (await getFlows()).find((entry) => entry.stateJson?.milestone === 'M001'));
  assert.equal(flow.status, 'waiting', 'flow waits for GSD events; it does not invent a child execution');
  assert.ok(card.notes.includes(flow.flowId));
  // Atomic replacement must remain watched, and a repeated event must not create records.
  const blocked = '# GSD State\n\n**Active Milestone:** M001: Native worktree\n**Phase:** blocked\n\n## Blockers\n- Fixture needs input\n';
  await writeFile(join(worktree.path, '.gsd/STATE.md.tmp'), blocked);
  await rename(join(worktree.path, '.gsd/STATE.md.tmp'), join(worktree.path, '.gsd/STATE.md'));
  await eventually(async () => (await getCards()).find((entry) => entry.id === card.id && entry.status === 'blocked'));
  await writeFile(join(worktree.path, '.gsd/STATE.md'), blocked);
  await stop();
  await start();
  const restored = await eventually(async () => (await getCards()).find((entry) => entry.id === card.id));
  assert.equal(restored.status, 'blocked');
  assert.equal((await getCards()).length, 1);
  assert.equal((await getFlows()).length, 1);
  await writeFile(join(worktree.path, '.gsd/STATE.md'), '# GSD State\n\n**Phase:** complete\n');
  await eventually(async () => (await getCards()).find((entry) => entry.id === card.id && entry.status === 'done'));
  const completed = (await getFlows()).find((entry) => entry.flowId === flow.flowId);
  assert.equal(completed.status, 'succeeded');

  // The native GSD registry can appear after Gateway startup. No OpenClaw
  // session, skill, project registration call, or GSD-specific config is needed.
  const external = join(root, 'external-project');
  await run('git', ['init', '--initial-branch=main', external]);
  await run('git', ['-C', external, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture']);
  const externalState = join(env.GSD_HOME, 'projects', 'fixture-project');
  await mkdir(externalState, { recursive: true });
  const { symlink } = await import('node:fs/promises');
  await symlink(externalState, join(external, '.gsd'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(externalState, 'STATE.md'), '# GSD State\n\n**Active Milestone:** M002: External project\n**Phase:** planning\n');
  await writeFile(join(externalState, 'repo-meta.json'), JSON.stringify({ version: 1, gitRoot: external }));
  await eventually(async () => (await getCards()).find((entry) => entry.metadata.automation.workspace.path === external));
  assert.ok((await rpc('projects.list')).projects.some((entry) => entry.displayName === 'external-project'));
  assert.equal((await getCards()).length, 2);
  assert.equal((await getFlows()).length, 2);

  // Optional Workboard can be disabled and re-enabled without changing GSD config.
  await stop();
  let config = JSON.parse(await readFile(configPath, 'utf8'));
  config.plugins.entries.workboard.enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  await start();
  await writeFile(join(externalState, 'STATE.md'), '# GSD State\n\n**Phase:** complete\n');
  await eventually(async () => (await getFlows()).find((entry) => entry.stateJson?.projectDir === external && entry.status === 'succeeded'));
  await stop();
  config.plugins.entries.workboard.enabled = true;
  await writeFile(configPath, JSON.stringify(config));
  await start();
  await eventually(async () => (await getCards()).find((entry) => entry.metadata.automation.workspace.path === external && entry.status === 'done'));
  assert.equal((await getCards()).length, 2);
  // The real database overrides stale complete Markdown. Only GSD's public
  // read contract is used by the plugin; this fixture uses GSD's own DB writer.
  await run(process.execPath, ['--input-type=module', '-e', `
    import { createJiti } from 'jiti';
    const jiti = createJiti(process.cwd() + '/package.json');
    const db = await jiti.import('./src/resources/extensions/gsd/gsd-db.ts');
    if (!db.openDatabase(process.argv[1])) throw new Error('Fixture database unavailable');
    db.insertMilestone({ id: 'M003', title: 'Database authority', status: 'active' });
    db.insertSlice({ id: 'S01', milestoneId: 'M003', title: 'Slice', status: 'active', risk: 'low', depends: [], sequence: 1 });
    db.insertTask({ id: 'T01', milestoneId: 'M003', sliceId: 'S01', title: 'Task', status: 'pending', sequence: 1 });
    db.closeDatabase();
  `, join(externalState, 'gsd.db')], { cwd: repoDir });
  const dbFlow = await eventually(async () => (await getFlows()).find((entry) => entry.stateJson?.milestone === 'M003'));
  assert.equal(dbFlow.stateJson.tasks, '0/1');
  assert.notEqual(dbFlow.status, 'succeeded');
  const stableRevision = dbFlow.revision;
  await rpc('health');
  assert.equal((await getFlows()).find((entry) => entry.flowId === dbFlow.flowId).revision, stableRevision, 'reader bookkeeping does not cause repeated flow writes');
  // An unreadable DB must not fall back to the stale complete projection.
  await writeFile(join(externalState, 'gsd.db'), 'invalid database');
  await eventually(async () => (await getFlows()).find((entry) => entry.flowId === dbFlow.flowId && entry.stateJson?.unavailable === true));
  assert.equal((await getCards()).find((entry) => entry.metadata.automation.workspace.path === external).status, 'blocked');
  const worktrees = await rpc('worktrees.list');
  assert.ok(worktrees.worktrees.some((entry) => entry.id === worktree.id));
  await rpc('worktrees.remove', { id: worktree.id });
  assert.equal((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout, '');
});
