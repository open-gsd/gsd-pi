/**
 * Opt-in acceptance against a real, disposable OpenClaw Gateway and the npm
 * artifact. No mocked Gateway, theme bridge, project catalog, or HTTP response.
 * Build core, plugin, and staged web host with
 * `pnpm run build:web-host && pnpm run build:web-host:openclaw` first, then:
 * OPENCLAW_BIN=/path/to/openclaw node integrations/openclaw/test/browser-host.mjs
 * CHROME_BIN optionally selects an existing Chromium; otherwise Playwright's
 * installed Chromium is used. GSD_BROWSER_EVIDENCE_DIR retains sanitized proof.
 * GSD_BROWSER_GSD_TARBALL reuses an existing root-package artifact (copied into
 * this test's fixture), avoiding another prepack while other checks are running.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(pluginDir, '../..');
const basePath = '/plugins/open-gsd-openclaw/web';
const openclaw = process.env.OPENCLAW_BIN;
assert.ok(openclaw, 'Set OPENCLAW_BIN to an installed OpenClaw host; this test never uses the live Gateway');
if (!process.env.GSD_BROWSER_GSD_TARBALL) {
  await access(join(repoDir, 'dist/web/standalone/server.js'));
  await access(join(repoDir, 'dist/web/standalone/openclaw/server.js'));
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'gsd-openclaw-browser-')));
const stateDir = join(root, 'host');
const configPath = join(stateDir, 'openclaw.json');
const evidenceDir = resolve(process.env.GSD_BROWSER_EVIDENCE_DIR ?? join(pluginDir, 'reports/browser-host'));
const token = randomUUID();
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: process.env.TMPDIR,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  GSD_HOME: join(root, 'gsd-home'),
  NO_COLOR: '1',
  GSD_SKIP_RTK_INSTALL: '1',
};
const evidence = { timestamp: new Date().toISOString(), isolated: true, checks: [] };
let gateway;
let browser;
let context;
let page;
let gatewayLogs = '';
const browserErrors = [];
const network = [];
const methods = [];
let gatewayPort;
let webPort;
const run = (file, args, options = {}) => exec(file, args, {
  env, cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options,
});
const cli = (args, options = {}) => run(openclaw, args, options);
const redact = (text) => String(text).replaceAll(token, '[fixture-token]').replace(/openclaw_portal=[^\s&"']+/g, 'openclaw_portal=[redacted]');
const proof = (name, details = {}) => {
  evidence.checks.push({ name, ...details });
  console.log(JSON.stringify({ phase: name, ...details }));
};
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}
async function eventually(check, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    if (gateway && (gateway.exitCode !== null || gateway.signalCode !== null)) break;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${description} did not converge${last ? `: ${last.message}` : ''}`);
}
async function rpc(method, params = {}) {
  const { stdout } = await cli(['gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--url', `ws://127.0.0.1:${gatewayPort}`, '--token', token]);
  return JSON.parse(stdout);
}
async function browserRpc(method, params = {}) {
  // Use the actual authenticated Control UI connection, including its profile.
  // Do not replace the host with a fixture or bypass Gateway authorization.
  return page.evaluate(async ({ method, params }) => {
    const client = document.querySelector('openclaw-app')?.runtime?.context.gateway.snapshot.client;
    if (!client) throw new Error('Native Control UI Gateway connection is not ready');
    return client.request(method, params);
  }, { method, params });
}
async function start() {
  gateway = spawn(openclaw, ['gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback', '--tailscale', 'off'], {
    env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout.on('data', (chunk) => { gatewayLogs += chunk; });
  gateway.stderr.on('data', (chunk) => { gatewayLogs += chunk; });
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 'isolated Gateway readiness', 180_000);
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}${basePath}/api/boot`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const boot = await response.json();
    return boot.project === null && boot.bridge === null && boot.workspace === null;
  }, 'owned GSD host readiness', 180_000);
}
async function stop() {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
  const exited = once(gateway, 'exit');
  gateway.kill('SIGTERM');
  const timer = setTimeout(() => gateway.kill('SIGKILL'), 20_000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function assertClosed(listenPort) {
  let reachable = true;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await fetch(`http://127.0.0.1:${listenPort}/`, { signal: AbortSignal.timeout(500) }); }
    catch { reachable = false; break; }
    await delay(250);
  }
  assert.equal(reachable, false, `owned listener ${listenPort} remained after Gateway shutdown`);
}
const gatewayUrl = () => `http://127.0.0.1:${gatewayPort}`;
async function openEmbedded() {
  await page.goto(`${gatewayUrl()}/plugin?plugin=open-gsd-openclaw&id=open-gsd-openclaw-web#token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.locator('openclaw-plugin-page iframe').waitFor({ timeout: 90_000 });
  const iframe = page.locator('openclaw-plugin-page iframe');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts', 'embedded frame must remain opaque-origin');
  const frame = await (await iframe.elementHandle()).contentFrame();
  assert.ok(frame);
  await frame.getByTestId('project-selection-gate').waitFor({ timeout: 90_000 });
  await frame.getByText('Native Alpha', { exact: true }).waitFor({ timeout: 60_000 });
  await frame.getByText('Native Beta', { exact: true }).waitFor();
  return frame;
}
async function assertTheme(frame, mode) {
  await eventually(async () => {
    const host = await page.evaluate(() => {
      const root = document.documentElement;
      return { mode: root.dataset.themeMode, background: getComputedStyle(root).getPropertyValue('--bg').trim(), primary: getComputedStyle(root).getPropertyValue('--primary').trim() };
    });
    const child = await frame.evaluate(() => {
      const root = document.documentElement;
      return { mode: root.classList.contains('dark') ? 'dark' : 'light', background: getComputedStyle(root).getPropertyValue('--background').trim(), primary: getComputedStyle(root).getPropertyValue('--primary').trim() };
    });
    return host.mode === mode && child.mode === mode && !!host.background && child.background === host.background && !!host.primary && child.primary === host.primary;
  }, `embedded ${mode} theme matches actual host palette`);
}
try {
  await mkdir(stateDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  // Exercise both released artifacts. The plugin must run the prefixed server
  // from an npm-installed GSD package, without source-checkout dependencies.
  let gsdPacked;
  if (process.env.GSD_BROWSER_GSD_TARBALL) {
    const filename = 'gsd-under-test.tgz';
    const tarball = join(root, filename);
    await copyFile(resolve(process.env.GSD_BROWSER_GSD_TARBALL), tarball);
    const metadata = JSON.parse((await run('tar', ['-xOf', tarball, 'package/package.json'])).stdout);
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(tarball)) hash.update(chunk);
    gsdPacked = { name: metadata.name, version: metadata.version, filename, shasum: hash.digest('hex') };
  } else {
    await run(process.execPath, [join(repoDir, 'scripts/prepack-resolve-workspace.cjs')], { cwd: repoDir });
    try {
      gsdPacked = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: repoDir, timeout: 300_000 })).stdout)[0];
    } finally {
      await run(process.execPath, [join(repoDir, 'scripts/postpack-restore-workspace.cjs')], { cwd: repoDir });
    }
  }
  const installDir = join(root, 'installed');
  await mkdir(installDir);
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'gsd-browser-fixture', private: true }));
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', join(root, gsdPacked.filename)], { cwd: installDir, timeout: 300_000 });
  const packageRoot = join(installDir, 'node_modules/@opengsd/gsd-pi');
  await access(join(packageRoot, 'dist/web/standalone/openclaw/server.js'));
  evidence.gsdPackage = { name: gsdPacked.name, version: gsdPacked.version, shasum: gsdPacked.shasum };
  proof('packed-gsd-installed');
  gatewayPort = await port();
  webPort = await port();
  const fixtures = [join(root, 'alpha'), join(root, 'beta')];
  const standaloneRoot = join(root, 'standalone-projects');
  await mkdir(standaloneRoot);
  const standaloneProject = join(standaloneRoot, 'standalone-only');
  for (const fixture of [...fixtures, standaloneProject]) {
    await run('git', ['init', '--initial-branch=main', fixture]);
    await writeFile(join(fixture, 'README.md'), 'Native project fixture; no GSD state directory.\n');
    await run('git', ['-C', fixture, 'add', 'README.md']);
    await run('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  }
  await mkdir(env.GSD_HOME, { recursive: true });
  const preferencesBefore = JSON.stringify({ devRoot: standaloneRoot });
  await writeFile(join(env.GSD_HOME, 'web-preferences.json'), preferencesBefore);
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: 'local', port: gatewayPort, auth: { mode: 'token', token }, controlUi: { enabled: true, experimental: { customPlugins: true } } },
    agents: { defaults: { workspace: fixtures[0], model: { primary: 'anthropic/claude-sonnet-4-5' }, heartbeat: { every: '0m' } } },
    plugins: { allow: ['open-gsd-openclaw'], entries: { 'open-gsd-openclaw': { enabled: true, config: { webUi: { enabled: true, packageRoot, port: webPort } } } } },
    mcp: { servers: { gsd: { command: process.execPath, args: [join(packageRoot, 'packages/mcp-server/bin/gsd-mcp-server.js')], env: { GSD_CLI_PATH: join(packageRoot, 'dist/loader.js'), GSD_HOME: env.GSD_HOME } } } },
  }));
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: pluginDir })).stdout)[0];
  const manifest = JSON.parse(await readFile(join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
  assert.ok(manifest.controlUi?.entry, 'normal plugin build must generate manifest.controlUi.entry');
  assert.ok(packed.files.some((file) => file.path === manifest.controlUi.entry.replace(/^\.\//, '')), 'npm package must include the native UI bundle referenced by its manifest');
  await cli(['plugins', 'install', `npm-pack:${join(root, packed.filename)}`, '--force', '--accept-capabilities'], { timeout: 180_000 });
  const inspection = JSON.parse((await cli(['plugins', 'inspect', 'open-gsd-openclaw', '--runtime', '--json'])).stdout);
  assert.equal(inspection.plugin.status, 'loaded');
  evidence.package = { name: packed.name, version: packed.version, shasum: packed.shasum, uiEntry: manifest.controlUi.entry };
  proof('packed-native-ui-installed');
  await start();
  const alpha = await rpc('projects.register', { path: fixtures[0], name: 'Native Alpha' });
  const beta = await rpc('projects.register', { path: fixtures[1], name: 'Native Beta' });
  const nativeCatalog = (await rpc('projects.list')).projects;
  assert.ok(nativeCatalog.some((entry) => entry.id === alpha.id));
  assert.ok(nativeCatalog.some((entry) => entry.id === beta.id));
  // Native workspace aliases may duplicate a registered checkout. The UI
  // renders that path once, under its explicit registered identity/name.
  const nativeCount = nativeCatalog.length;
  // Chromium's Unix-domain singleton socket needs a short temporary path.
  // Keep large package fixtures in TMPDIR, but its browser-only socket in /tmp.
  browser = await chromium.launch({ env: { ...env, TMPDIR: process.platform === 'win32' ? env.TMPDIR : '/tmp' }, headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  context.on('page', (page) => {
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith(basePath)) network.push({ path, status: response.status() });
    });
    page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.type === 'req') methods.push(frame.method); } catch { /* binary frame */ }
    }));
  });
  page = await context.newPage();
  let frame = await openEmbedded();
  const activated = await eventually(async () => {
    const status = await rpc('plugins.controlUi.status', { pluginId: 'open-gsd-openclaw' });
    return status.clients?.some((client) => client.activations.some((report) => report.pluginId === 'open-gsd-openclaw' && report.status === 'activated' && report.revision)) ? status : false;
  }, 'native browser activation receipt');
  evidence.activation = activated;
  const listed = await browserRpc('gsd.ui.projects.list', { detail: true });
  assert.deepEqual(listed.map((entry) => entry.projectId).sort(), [alpha.id, beta.id].sort());
  assert.deepEqual(listed.map((entry) => entry.path).sort(), fixtures.sort());
  proof('native-project-catalog-rendered', { registered: listed.length });

  // Same-origin standalone page has a saved GSD preference, independently of
  // the opaque embedded frame. Seeding localStorage is test data, not a mock.
  const standalone = await context.newPage();
  await standalone.goto(`${gatewayUrl()}${basePath}/`, { waitUntil: 'domcontentloaded' });
  await standalone.evaluate(() => localStorage.setItem('theme', 'light'));
  await standalone.reload({ waitUntil: 'domcontentloaded' });
  await standalone.waitForFunction(() => document.documentElement.classList.contains('light'));
  await standalone.getByText('standalone-only', { exact: true }).waitFor();
  assert.equal(await standalone.getByText('Native Alpha', { exact: true }).count(), 0);
  assert.equal(await frame.getByText('standalone-only', { exact: true }).count(), 0);
  assert.equal(await readFile(join(env.GSD_HOME, 'web-preferences.json'), 'utf8'), preferencesBefore);

  await browserRpc('themes.set', { id: 'claw', mode: 'dark' });
  await assertTheme(frame, 'dark');
  await page.screenshot({ path: join(evidenceDir, 'embedded-dark.png'), fullPage: true });
  await browserRpc('themes.set', { mode: 'light' });
  await assertTheme(frame, 'light');
  await page.screenshot({ path: join(evidenceDir, 'embedded-light.png'), fullPage: true });
  await browserRpc('themes.set', { mode: 'dark' });
  await assertTheme(frame, 'dark');
  const priorPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
  await browserRpc('themes.set', { mode: 'dark', appearance: { accent: '#a63fe1' } });
  await eventually(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())) !== priorPrimary, 'same-mode host accent update');
  await assertTheme(frame, 'dark');
  assert.equal(await standalone.evaluate(() => localStorage.getItem('theme')), 'light');
  assert.equal(await standalone.evaluate(() => document.documentElement.classList.contains('light')), true);
  await standalone.reload({ waitUntil: 'domcontentloaded' });
  await standalone.waitForFunction(() => document.documentElement.classList.contains('light'));
  assert.equal(await standalone.evaluate(() => document.documentElement.style.getPropertyValue('--background')), '', 'host override must not leak into standalone DOM');
  assert.equal(await readFile(join(env.GSD_HOME, 'web-preferences.json'), 'utf8').catch(() => null), preferencesBefore);
  assert.equal(methods.some((method) => method === 'gsd.ui.preferences.selectRoot' || method === 'gsd.ui.preferences.setDevRoot'), false);
  proof('host-theme-live-and-standalone-independent');

  // Reload creates a new sandbox document and nonce; the retained host theme
  // must bind again, without persisting it as GSD's own setting.
  frame = await openEmbedded();
  await assertTheme(frame, 'dark');
  await browserRpc('themes.set', { mode: 'light' });
  await assertTheme(frame, 'light');
  assert.equal(await standalone.evaluate(() => localStorage.getItem('theme')), 'light');
  await standalone.close();
  await page.close();
  assert.equal((await fetch(`http://127.0.0.1:${webPort}${basePath}/api/boot`)).status, 200, 'closing browser does not terminate plugin-owned host');
  proof('remount-theme-and-tab-lifecycle');
  assert.ok(network.some((item) => item.path.includes('/_next/') && item.status === 200), 'prefixed web assets were served');
  assert.deepEqual(network.filter((item) => item.status >= 400), [], 'embedded assets/APIs must not fail');
  assert.deepEqual(browserErrors, [], 'browser runtime must not throw');
  await stop();
  await assertClosed(webPort);
  await assertClosed(gatewayPort);
  proof('owned-host-clean-shutdown');
  await start();
  assert.equal((await rpc('projects.list')).projects.length, nativeCount, 'native registry survives Gateway restart');
  assert.equal((await rpc('portal.list')).portals.filter((entry) => entry.port === webPort).length, 1, 'restart does not leak portal registrations');
  page = await context.newPage();
  frame = await openEmbedded();
  await assertTheme(frame, 'light');
  proof('isolated-restart-restores-ui-and-projects');
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.failure = redact(error.stack ?? error);
  process.exitCode = 1;
  console.error(evidence.failure);
} finally {
  await browser?.close();
  await stop();
  if (webPort) {
    try { await assertClosed(webPort); } catch (error) { evidence.cleanupFailure = error.message; evidence.ok = false; process.exitCode = 1; }
  }
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'proof.json'), JSON.stringify({ ...evidence, browserErrors, network, methods }, null, 2) + '\n');
  await writeFile(join(evidenceDir, 'gateway.log'), redact(gatewayLogs));
  await rm(root, { recursive: true, force: true });
}
