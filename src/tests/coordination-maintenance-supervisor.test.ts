// Actual native process boundary. Preloads instrument tests only, never production policy.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = fileURLToPath(new URL("../bootstrap.ts", import.meta.url));
const worker = fileURLToPath(new URL("../coordination-maintenance-worker.ts", import.meta.url));

test("bare fixed backend refuses without an IPC parent", () => {
  const result = spawnSync(process.execPath, [worker], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /maintenance-supervision-required/);
});

for (const mode of ["startup", "import", "signal", "eof", "blocked-output"] as const) {
  test(`native supervisor reaps its own backend: ${mode}`, { timeout: 10_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "w067-supervisor-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pidFile = join(root, "pid");
    const preload = join(root, "instrument.cjs");
    writeFileSync(preload, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const isWorker = process.argv[1]?.endsWith('coordination-maintenance-worker.ts');
if (!isWorker) {
  const timer = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms !== 60000) return timer(fn, ms, ...args);
    // Exclude cold tsx startup from the accelerated test-only work budget.
    // The timer remains in the responsive parent, independent of blocked child JS.
    const started = Date.now();
    let observed;
    const poll = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(pidFile)})) observed ??= Date.now();
      if ((observed && Date.now() - observed >= 1200) || Date.now() - started >= 4000) {
        clearInterval(poll); fn(...args);
      }
    }, 20);
    return poll;
  };
  if (${JSON.stringify(mode)} === "blocked-output") {
    const write = process.stdout.write.bind(process.stdout);
    let flooded = false;
    process.stdout.write = function(chunk, ...args) {
      if (!flooded && typeof chunk === "string" && chunk.includes('"termination"')) {
        flooded = true;
        for (let index = 0; index < 512; index++) write(Buffer.alloc(1024, 97));
      }
      return write(chunk, ...args);
    };
  }
} else {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  if (${JSON.stringify(mode)} === 'startup') while (true) {}
  if (${JSON.stringify(mode)} === 'import') {
    const read = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (String(path).includes('coordination-maintenance-backend.')) while (true) {}
      return read.call(this, path, ...args);
    };
    syncBuiltinESMExports();
  }
}
`);
    const child = spawn(process.execPath, ["--import", "tsx", bootstrap, "coordination-maintenance", "--project", root, "--json"], {
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, JITI_FS_CACHE: "false" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (mode === "blocked-output") child.stdout.destroy();
    });
    let stdout = "";
    let stderr = "";
    if (mode !== "blocked-output") child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      if (mode === "blocked-output") child.once("exit", resolve);
      else child.once("close", resolve);
    });
    if (mode === "signal" || mode === "eof" || mode === "blocked-output") {
      const until = Date.now() + 4_000;
      while (!existsSync(pidFile) && Date.now() < until && child.exitCode === null) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(existsSync(pidFile), `backend did not start; stdout=${stdout}; stderr=${stderr}`);
      if (mode === "signal" || mode === "blocked-output") child.kill("SIGTERM"); else child.stdin.end();
    }
    const code = mode === "blocked-output"
      ? await Promise.race([exited, new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 5_000))])
      : await exited;
    assert.notEqual(code, "timeout", "frontend must exit after bounded output flush");
    if (mode === "blocked-output") child.stdout.destroy();
    assert.equal(code, 1, stderr);
    let pid: number;
    try { pid = Number(readFileSync(pidFile, "utf8")); }
    catch { assert.fail(`backend PID not recorded; stdout=${stdout}; stderr=${stderr}`); }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    if (mode !== "eof" && mode !== "blocked-output") {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const reply = JSON.parse(lines[lines.length - 1]) as {
        requestId: unknown;
        result: { status?: unknown; code?: unknown; termination?: unknown };
      };
      assert.deepEqual(Object.keys(reply).sort(), ["requestId", "result"]);
      assert.equal(reply.requestId, null);
      assert.deepEqual(Object.keys(reply.result).sort(), ["code", "status", "termination"]);
      assert.equal(reply.result.status, "refused");
      assert.equal(reply.result.code, "maintenance-unavailable");
      assert.ok(reply.result.termination === "confirmed" || reply.result.termination === "unconfirmed");
    }
    assert.doesNotMatch(stdout + stderr, /stack|SELECT|UPDATE/);
  });
}
