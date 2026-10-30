// Native transport UNIT tests mock only the fixed host interface: NOT engine/writer proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertMaintenancePackageCompatibility,
  MAINTENANCE_LIMITS,
  runCoordinationMaintenanceProtocol,
} from "../coordination-maintenance-backend.js";
import { parseCoordinationMaintenanceArgs } from "../coordination-maintenance-cli.js";
import type { CoordinationMaintenanceHost } from "../resources/shared/coordination-maintenance-contract.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const request = (command: string, input: unknown = {}, requestId = "req1") => JSON.stringify({ requestId, command, input }) + "\n";

function fixture(input: Readable) {
  const calls: unknown[] = [];
  const lines: string[] = [];
  let opens = 0;
  let closes = 0;
  const output = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const host: CoordinationMaintenanceHost = {
    prepare(value) { calls.push(["prepare", value]); return { status: "prepared", previewHash: "unit-only" }; },
    apply(value) { calls.push(["apply", value]); return { status: "committed" }; },
    receipt(value) { calls.push(["receipt", value]); return { status: "replayed" }; },
    close() { closes++; },
  };
  const open = async (projectDir: string) => { assert.equal(projectDir, "/unit-project"); opens++; return host; };
  return { input, output, host, open, calls, lines, get opens() { return opens; }, get closes() { return closes; } };
}

const run = (f: ReturnType<typeof fixture>, signals?: NodeJS.Process) => runCoordinationMaintenanceProtocol("/unit-project", { input: f.input, output: f.output, signals }, f.open);

test("unit: exact argument grammar, not prompt/auto fallback", () => {
  assert.deepEqual(parseCoordinationMaintenanceArgs(["coordination-maintenance", "--project", "/tmp/project", "--json"]), { projectDir: "/tmp/project" });
  assert.equal(parseCoordinationMaintenanceArgs(["coordination-maintenance", "--help"]), "help");
  for (const args of [[], ["coordination-maintenance"], ["--auto", "coordination-maintenance"], ["coordination-maintenance", "--project", "relative", "--json"], ["coordination-maintenance", "--json", "--project", "/tmp"], ["coordination-maintenance", "--project", "/tmp", "--json", "--auto"], ["coordination-maintenance", "--project", "/tmp\0x", "--json"]]) {
    assert.equal(parseCoordinationMaintenanceArgs(args), null);
  }
});

test("unit: fragmented newline frames use one private host and fixed methods", async () => {
  const text = request("prepare", { target: "one" }) + request("apply", { seal: "engine-owned" }, "req2") + request("receipt", {}, "req3");
  const bytes = Buffer.from(text);
  const f = fixture(Readable.from([...bytes].map(byte => Buffer.from([byte]))));
  assert.equal(await run(f), 0);
  assert.equal(f.opens, 1);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.calls, [["prepare", { target: "one" }], ["apply", { seal: "engine-owned" }], ["receipt", {}]]);
  assert.deepEqual(f.lines.map(line => JSON.parse(line).result.status), ["prepared", "committed", "replayed"]);
  assert.deepEqual(f.lines.map(line => JSON.parse(line).requestId), ["req1", "req2", "req3"]);
});

for (const [name, text] of Object.entries({
  empty: "", blank: "\n", malformed: "{\n", array: "[]\n", scalar: "null\n",
  extra: '{"requestId":"r","command":"prepare","input":{},"actor":"fake"}\n',
  prototype: '{"requestId":"r","command":"prepare","input":{},"__proto__":{}}\n',
  missing: '{"requestId":"r","command":"prepare"}\n',
  callback: request("close"), sql: request("executeSql"),
  requestId: request("prepare", {}, "secret/path"), numberId: '{"requestId":1,"command":"prepare","input":{}}\n',
  unterminated: request("prepare").trimEnd(), invalidUtf8: Buffer.from([0xff, 10]),
})) {
  test(`unit: ${name} frame refused before factory open`, async () => {
    const f = fixture(Readable.from([text]));
    assert.equal(await run(f), 1);
    assert.equal(f.opens, 0);
    assert.equal(f.closes, 0);
    assert.deepEqual(JSON.parse(f.lines.join("")), { requestId: null, result: { status: "refused", code: "maintenance-refused" } });
  });
}

test("unit: second prepare cannot retarget even with a new requestId", async () => {
  const f = fixture(Readable.from([request("prepare", { target: "one" }) + request("prepare", { target: "two" }, "second")]));
  assert.equal(await run(f), 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.closes, 1);
});

test("unit: engine refusal terminates with nonzero and closes", async () => {
  const f = fixture(Readable.from([request("apply") + request("receipt")]));
  f.host.apply = () => ({ status: "refused", code: "engine-unit-refusal" });
  assert.equal(await run(f), 1);
  assert.equal(f.lines.length, 1);
  assert.equal(f.closes, 1);
});

test("unit: factory/method/close exceptions never expose payloads", async () => {
  const fixtureSentinel = "fixture-token-value";
  const f = fixture(Readable.from([request("prepare", { token: fixtureSentinel })]));
  f.host.prepare = () => { throw new Error("/private/hostname DO-NOT-EMIT argv env"); };
  assert.equal(await run(f), 1);
  assert.equal(f.closes, 1);
  assert.doesNotMatch(f.lines.join(""), /private|hostname|DO-NOT-EMIT|argv|env/);
  assert.ok(!f.lines.join("").includes(fixtureSentinel));
  const g = fixture(Readable.from([request("prepare")]));
  assert.equal(await runCoordinationMaintenanceProtocol("/unit-project", g, async () => { throw new Error("DO-NOT-EMIT"); }), 1);
  assert.doesNotMatch(g.lines.join(""), /DO-NOT-EMIT/);
  const h = fixture(Readable.from([request("prepare")]));
  h.host.close = () => { throw new Error("DO-NOT-EMIT"); };
  assert.equal(await run(h), 1);
});

test("unit: byte, aggregate, frame-count and reply bounds", async () => {
  for (const chunks of [
    ["x".repeat(MAINTENANCE_LIMITS.frameBytes + 1)],
    ["x".repeat(MAINTENANCE_LIMITS.frameBytes + 1) + "\n"],
    ["x".repeat(MAINTENANCE_LIMITS.totalBytes + 1)],
    [request("receipt").repeat(MAINTENANCE_LIMITS.frames + 1)],
    Array.from({ length: 6 }, () => request("receipt", "x".repeat(50_000))),
  ]) {
    const f = fixture(Readable.from(chunks));
    assert.equal(await run(f), 1);
    assert.ok(f.calls.length <= MAINTENANCE_LIMITS.frames);
    assert.equal(f.closes, f.opens);
  }
  const f = fixture(Readable.from([request("prepare")]));
  f.host.prepare = () => ({ status: "prepared", oversized: "x".repeat(MAINTENANCE_LIMITS.frameBytes) });
  assert.equal(await run(f), 1);
  assert.equal(f.closes, 1);
});

test("unit: EOF and input error close the opened host", async () => {
  const input = new PassThrough();
  const f = fixture(input);
  const result = run(f);
  input.write(request("prepare"));
  await new Promise(resolve => setImmediate(resolve));
  input.destroy(new Error("DO-NOT-EMIT"));
  assert.equal(await result, 1);
  assert.equal(f.closes, 1);
});

test("unit: timeout and signals close and unregister without waiting for EOF", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(new PassThrough());
  const result = run(f);
  f.input.push(request("prepare"));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(MAINTENANCE_LIMITS.lifetimeMs);
  assert.equal(await result, 1);
  assert.equal(f.closes, 1);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const signals = new EventEmitter() as NodeJS.Process;
    const g = fixture(new PassThrough());
    const pending = run(g, signals);
    g.input.push(request("prepare"));
    await new Promise(resolve => setImmediate(resolve));
    signals.emit(signal);
    assert.equal(await pending, 1);
    assert.equal(g.closes, 1);
    assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
  }
});

test("unit: deadline bounds factory loading and closes a late unit host", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(Readable.from([request("prepare")]));
  let finish: ((host: CoordinationMaintenanceHost) => void) | undefined;
  const pending = runCoordinationMaintenanceProtocol("/unit-project", f, async () => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(MAINTENANCE_LIMITS.lifetimeMs);
  assert.equal(await pending, 1);
  assert.ok(finish);
  finish(f.host);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closes, 1);
  assert.equal(f.calls.length, 0);
});

test("unit: broken output is terminal and closes host without raw diagnostics", async () => {
  const f = fixture(Readable.from([request("prepare")]));
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("DO-NOT-EMIT")); } });
  assert.equal(await runCoordinationMaintenanceProtocol("/unit-project", { input: f.input, output }, f.open), 1);
  assert.equal(f.closes, 1);
});

// Actual source bootstrap child, not a source-order assertion. A test-only Node
// loader denies ordinary loader/cli imports; fs guards deny link/resource writes.
// HOME, GSD dirs, cwd and environment are isolated, never production bypass flags.
function nativeChild(args: string[], t: import("node:test").TestContext, input = "") {
  const home = mkdtempSync(join(tmpdir(), "w067-native-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const guard = join(home, "guard.mjs");
  const loader = join(home, "deny-loader.mjs");
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if ((context.parentURL?.endsWith('/src/bootstrap.ts') && specifier === './loader.js') || specifier.endsWith('/cli.js') || specifier === './cli.js') {
      process.stderr.write('FORBIDDEN_ORDINARY_STARTUP\\n'); throw new Error('blocked');
    }
    if (specifier === '@mariozechner/jiti' || specifier.endsWith('/gsd/coordination-maintenance.ts')) {
      process.stderr.write('FORBIDDEN_FACTORY_LOAD\\n'); throw new Error('blocked');
    }
    return next(specifier, context);
  }`);
  writeFileSync(guard, `import fs from 'node:fs';
    import { syncBuiltinESMExports, register } from 'node:module';
    for (const name of ['mkdirSync','symlinkSync','cpSync','rmSync','writeFileSync','copyFileSync']) {
      fs[name] = () => { process.stderr.write('FORBIDDEN_FILESYSTEM_WRITE\\n'); throw new Error('blocked by native-entry test'); };
    }
    syncBuiltinESMExports();
    register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(tsx).href, "--import", pathToFileURL(guard).href, join(root, "src/bootstrap.ts"), ...args], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home, GSD_HOME: join(home, "gsd"), GSD_AGENT_DIR: join(home, "agent"), TMPDIR: home, NO_COLOR: "1" },
    input, encoding: "utf8", timeout: 10_000, maxBuffer: 32_768,
  });
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stderr, /FORBIDDEN_|Error:|ERR_MODULE/);
  assert.deepEqual(readdirSync(home).filter(name => !["guard.mjs", "deny-loader.mjs"].includes(name) && !name.startsWith("tsx-")), []);
  return result;
}

test("actual bootstrap: native help exits without factory/session/resource writes", t => {
  const result = nativeChild(["coordination-maintenance", "--help"], t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: gsd coordination-maintenance/);
});

for (const args of [
  ["coordination-maintenance"], ["--auto", "coordination-maintenance"], ["--help", "coordination-maintenance"],
  ["coordination-maintenance", "--project", "relative", "--json"],
  ["coordination-maintenance", "--project", "/tmp", "--json", "--auto"],
  ["coordination-maintenance=prepare"], ["--coordination-maintenance"], ["--coordination-maintenance=prepare"],
]) {
  test(`actual bootstrap: fail closed ${args.join(" ")}`, t => {
    const result = nativeChild(args, t);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).result.code, "invalid-arguments");
  });
}

test("actual bootstrap: malformed frame with valid argv still cannot open factory", t => {
  const result = nativeChild(["coordination-maintenance", "--project", "/unit-project", "--json"], t);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).result.code, "maintenance-refused");
});

for (const input of ["not-json\n", '{"requestId":"x","command":"sql","input":{}}\n', "x".repeat(MAINTENANCE_LIMITS.frameBytes + 1)]) {
  test(`actual bootstrap: rejects ${input.length}-byte invalid input before backend loading`, t => {
    const result = nativeChild(["coordination-maintenance", "--project", "/tmp", "--json"], t, input);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).result.code, "maintenance-refused");
  });
}

test("unit: newer managed package fence is read-only and does not trust GSD_VERSION", t => {
  const home = mkdtempSync(join(tmpdir(), "w067-compat-"));
  const original = process.env.GSD_AGENT_DIR;
  t.after(() => { if (original === undefined) delete process.env.GSD_AGENT_DIR; else process.env.GSD_AGENT_DIR = original; rmSync(home, { recursive: true, force: true }); });
  process.env.GSD_AGENT_DIR = home;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = join(home, "managed-resources.json");
  assert.doesNotThrow(assertMaintenancePackageCompatibility);
  writeFileSync(manifest, JSON.stringify({ packageName: pkg.name, gsdVersion: "999.0.0" }));
  assert.throws(assertMaintenancePackageCompatibility);
  writeFileSync(manifest, JSON.stringify({ packageName: pkg.name, gsdVersion: pkg.version }));
  const before = readFileSync(manifest, "utf8");
  assert.doesNotThrow(assertMaintenancePackageCompatibility);
  assert.equal(readFileSync(manifest, "utf8"), before);
  writeFileSync(manifest, "{");
  assert.throws(assertMaintenancePackageCompatibility);
});
