import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { GsdPortalService } from '../dist/portals.js';
if (!process.env.OPENCLAW_BIN || !process.env.GSD_PORTAL_PACKAGE_ROOT) {
  throw new Error('Set OPENCLAW_BIN and GSD_PORTAL_PACKAGE_ROOT; this opt-in proof opens and closes a real native Gateway portal.');
}
const packageRoot = await realpath(process.env.GSD_PORTAL_PACKAGE_ROOT);
const host = createRequire(await realpath(process.env.OPENCLAW_BIN));
const repo = createRequire(join(packageRoot, 'package.json'));
const { callGatewayFromCli } = await import(pathToFileURL(host.resolve('openclaw/plugin-sdk/gateway-runtime')));
const playwright = await import(pathToFileURL(repo.resolve('playwright')));
const { chromium } = playwright.default ?? playwright;
const evidenceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../validation');
await mkdir(evidenceDir, { recursive: true });
let opened;
let browser;
const evidence = { timestamp: new Date().toISOString(), mode: 'temporary live native portal; plugin activation not claimed' };
const service = new GsdPortalService({
  config: { packageRoot },
  env: { ...process.env },
  request: async (method, params) => {
    const result = await callGatewayFromCli(method, { timeout: '10000', json: true }, params,
      { progress: false, scopes: [method === 'portal.list' ? 'operator.read' : 'operator.write'] });
    if (method === 'portal.open') {
      opened = result;
      console.log(JSON.stringify({ phase: 'portal-opened', id: opened.id, port: opened.port, listenPort: opened.listenPort }));
    }
    return result;
  },
  onError: () => { evidence.unexpectedHostExit = true; },
});
try {
  console.log(JSON.stringify({ phase: 'starting-gsd-host' }));
  await service.start();
  console.log(JSON.stringify({ phase: 'host-ready' }));
  evidence.portal = { id: opened.id, port: opened.port, listenPort: opened.listenPort };
  evidence.unauthenticatedStatus = (await fetch(opened.publicUrl, { redirect: 'manual' })).status;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const page = await context.newPage();
  const responses = [];
  page.on('response', (response) => { const url = new URL(response.url()); responses.push({ path: url.pathname, status: response.status() }); });
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.name); });
  const main = await page.goto(opened.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  evidence.authenticatedStatus = main.status();
  await page.waitForFunction(() => !/Compiling|Scanning for projects/.test(document.body.innerText) && /project/i.test(document.body.innerText), undefined, { timeout: 60000 });
  evidence.title = await page.title();
  evidence.visibleText = (await page.locator('body').innerText()).slice(0, 2500);
  evidence.boot = await page.evaluate(async () => { const r = await fetch('/api/boot'); const b = await r.json(); return { status: r.status, project: b.project, bridge: b.bridge, workspace: b.workspace }; });
  if (await page.getByRole('button', { name: 'Browse', exact: true }).count()) {
    const browseResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browse-directories');
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    await page.getByRole('dialog', { name: 'Choose Folder' }).waitFor();
    evidence.browseStatus = (await browseResponse).status();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('dialog', { name: 'Choose Folder' }).waitFor({ state: 'hidden' });
    evidence.browseInteraction = evidence.browseStatus === 200;
  }
  evidence.requests = responses.filter(x => x.path.startsWith('/_next/') || x.path.startsWith('/api/')).slice(0, 40);
  evidence.pageErrors = errors;
  await page.screenshot({ path: evidenceDir + '/gsd-native-portal.png', fullPage: true });
  await page.close();
  await new Promise(resolve => setTimeout(resolve, 3500));
  evidence.aliveAfterTabClose = (await fetch('http://127.0.0.1:' + opened.port + '/api/boot')).status === 200;
  if (evidence.unauthenticatedStatus !== 401 || evidence.authenticatedStatus !== 200 || evidence.boot.project !== null || evidence.browseInteraction === false || errors.length) throw new Error('Portal acceptance failed');
  console.log(JSON.stringify({ phase: 'browser-proof', title: evidence.title, unauthenticated: evidence.unauthenticatedStatus, authenticated: evidence.authenticatedStatus, pageErrors: errors.length, aliveAfterTabClose: evidence.aliveAfterTabClose }));
} catch (error) {
  evidence.failure = String(error.message).replace(/openclaw_portal=[^\s&"']+/g, 'openclaw_portal=[redacted]');
  process.exitCode = 1;
  console.log(JSON.stringify({ phase: 'failed', error: evidence.failure }));
} finally {
  await browser?.close();
  await service.stop();
  const remaining = await callGatewayFromCli('portal.list', { timeout: '10000', json: true }, {}, { progress: false, scopes: ['operator.read'] });
  evidence.portalCleaned = !opened || !remaining.portals.some(p => p.id === opened.id);
  if (opened) {
    try { await fetch('http://127.0.0.1:' + opened.port + '/api/boot', { signal: AbortSignal.timeout(1000) }); evidence.hostCleaned = false; }
    catch { evidence.hostCleaned = true; }
  }
  await writeFile(evidenceDir + '/live-portal-proof.json', JSON.stringify(evidence, null, 2) + '\n');
  if (!evidence.portalCleaned || evidence.hostCleaned === false) process.exitCode = 1;
  console.log(JSON.stringify({ phase: 'cleanup', portalCleaned: evidence.portalCleaned, hostCleaned: evidence.hostCleaned }));
}
