// Independent-process supervision instrumentation, temporary fixture roots only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAINTENANCE_LIMITS, ATTENDED_MAINTENANCE_LIMITS } from "../coordination-maintenance-limits.ts";
const bootstrap = fileURLToPath(new URL("../bootstrap.ts", import.meta.url));
const worker = fileURLToPath(new URL("../coordination-maintenance-attended-worker.ts", import.meta.url));
test("bare attended backend refuses supervision; legacy budgets are unchanged", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", worker], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /maintenance-supervision-required/);
  assert.deepEqual(MAINTENANCE_LIMITS, { frameBytes: 65_536, totalBytes: 262_144, frames: 16, lifetimeMs: 60_000, cleanupMs: 1_000 });
  assert.equal(ATTENDED_MAINTENANCE_LIMITS.reviewMs, 600_000); assert.equal(ATTENDED_MAINTENANCE_LIMITS.writeMs, 60_000);
});
for (const mode of ["startup", "import", "writer"]) test(`attended supervisor independently terminates blocked ${mode}`, { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "w067-attended-supervision-FIXTURE-"));
  const pidFile = join(root, "worker.pid"); const preload = join(root, "instrument.cjs");
  writeFileSync(preload, `
const fs = require('node:fs');
const isWorker = process.argv[1]?.endsWith('coordination-maintenance-attended-worker.ts');
if (!isWorker) {
 const timer = global.setTimeout;
 global.setTimeout = (fn, ms, ...args) => {
  if (ms !== 600000 && ms !== 60000) return timer(fn, ms, ...args);
  if (ms === 600000 && ${JSON.stringify(mode)} === 'writer') return timer(fn, 18000, ...args);
  const started = Date.now(); let observed;
  const poll = setInterval(() => {
   if (fs.existsSync(${JSON.stringify(pidFile)})) observed ??= Date.now();
   if ((observed && Date.now() - observed >= 1200) || Date.now() - started > 15000) { clearInterval(poll); fn(...args); }
  }, 20);
  return poll;
 };
} else {
 fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
 if (${JSON.stringify(mode)} === 'startup') while (true) {}
 if (${JSON.stringify(mode)} === 'import') {
  const read = fs.readFileSync;
  fs.readFileSync = function(path, ...args) { if (String(path).includes('coordination-maintenance-backend.')) while (true) {} return read.call(this, path, ...args); };
  require('node:module').syncBuiltinESMExports();
 }
 if (${JSON.stringify(mode)} === 'writer') {
  const send = process.send.bind(process);
  process.send = function(message, ...rest) {
   const result = send(message, ...rest);
   if (message?.type === 'maintenance-attended-ready') { send({ type: 'maintenance-attended-writing' }); while (true) {} }
   return result;
  };
 }
}
`);
  const child = spawn(process.execPath, ["--import", "tsx", bootstrap, "coordination-maintenance", "--project", root, "--attended-same-machine"], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  child.stdout.resume(); child.stderr.resume();
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  assert.equal(code, 1); assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});
