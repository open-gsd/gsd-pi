import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native addon directly
const addonDir = path.resolve(__dirname, "..", "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node"),
];

let native;
for (const candidate of candidates) {
  try {
    native = require(candidate);
    break;
  } catch {
    // try next
  }
}

if (!native) {
  console.error("Native addon not found. Run `npm run build:native -w @gsd/native` first.");
  process.exit(1);
}

describe("native ps: listDescendants()", () => {
  test("returns an array for the current process", () => {
    const descendants = native.listDescendants(process.pid);
    assert.ok(Array.isArray(descendants));
  });

  test("returns empty array for non-existent PID", () => {
    // PID 2147483647 is extremely unlikely to exist
    const descendants = native.listDescendants(2147483647);
    assert.ok(Array.isArray(descendants));
    assert.equal(descendants.length, 0);
  });

  test("finds direct children and grandchildren", { timeout: 10_000 }, async (t) => {
    const child = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      child.once("spawn", () => process.send({ pid: child.pid }));
      const cleanup = () => { child.kill("SIGTERM"); process.exit(0); };
      process.once("SIGTERM", cleanup);
      process.once("disconnect", cleanup);
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let grandchildPid;
    t.after(async () => {
      // Clean up only our recorded fixture processes, even if enumeration fails.
      if (grandchildPid) {
        try { process.kill(grandchildPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    });
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
    assert.ok(Number.isInteger(message.pid) && message.pid > 0);
    grandchildPid = message.pid;
    assert.ok(native.listDescendants(process.pid).includes(child.pid), "enumeration must include our direct child");
    assert.ok(native.listDescendants(child.pid).includes(grandchildPid), "enumeration must include our grandchild");
    assert.ok(native.listDescendants(process.pid).includes(grandchildPid), "enumeration must traverse the child branch");
  });
});

describe("native ps: killTree()", () => {
  test("kills a process and its children", async () => {
    // Spawn a shell that spawns a sleep subprocess.
    const child = spawn("sh", ["-c", "sleep 60"], { stdio: "ignore" });

    // Wait until the kernel has actually assigned a pid and the process is
    // running. `once(child, 'spawn')` fires after the underlying process
    // has been created, which is the deterministic signal that killTree
    // will find something to kill.
    await once(child, "spawn");

    // Register the exit listener BEFORE killTree: Node EventEmitter does
    // not buffer events, so if the process exits between the kill and the
    // once() call the promise never resolves and the test hangs.
    const exited = once(child, "exit");
    const killed = native.killTree(child.pid, 9);
    assert.ok(killed >= 1, `should kill at least 1 process, killed: ${killed}`);

    // Verify the child is actually dead. `once` waits deterministically
    // for the exit signal rather than a wall-clock timeout.
    await exited;
  });

  test("returns 0 for non-existent PID", () => {
    const killed = native.killTree(2147483647, 9);
    assert.equal(killed, 0);
  });
});

describe("native ps: processGroupId()", () => {
  test("returns a number for the current process", () => {
    const pgid = native.processGroupId(process.pid);
    if (process.platform === "win32") {
      assert.equal(pgid, null);
    } else {
      assert.equal(typeof pgid, "number");
      assert.ok(pgid > 0);
    }
  });

  test("returns null for non-existent PID", () => {
    const pgid = native.processGroupId(2147483647);
    assert.equal(pgid, null);
  });
});

describe("native ps: killProcessGroup()", () => {
  test("returns false for non-existent process group", () => {
    const result = native.killProcessGroup(2147483647, 15);
    assert.equal(result, false);
  });
});
