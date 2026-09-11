// Project/App: gsd-pi
// File Purpose: Verify the non-blocking runEnvironmentChecksAsync is behaviourally
// identical to the synchronous runEnvironmentChecks (the health-widget render
// path was moved onto the async variant for performance), and that the single-
// scan checkPortConflicts still detects a real in-use port.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

import {
  runEnvironmentChecks,
  runEnvironmentChecksAsync,
  type EnvironmentCheckResult,
} from "../../doctor-environment.ts";

function makeProject(t: TestContext, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-env-async-"));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

// The disk_space check samples live free space separately in the sync and
// async paths, so its message embeds a size ("71.3GB free") that can shift
// between the two samples (CI run 34550581124: 71.2GB vs 71.3GB). Mask the
// volatile size before comparing; check id, status and detail stay verbatim.
function maskVolatileDiskSize(r: EnvironmentCheckResult): EnvironmentCheckResult {
  if (r.name !== "disk_space") return r;
  return { ...r, message: r.message.replace(/\d+(\.\d+)?(MB|GB) free/, "<size> free") };
}

// Stable, order-independent signature of a check-result set for comparison.
function normalize(results: EnvironmentCheckResult[]): string[] {
  return results
    .map(maskVolatileDiskSize)
    .map((r) => `${r.name}|${r.status}|${r.message}|${r.detail ?? ""}`)
    .sort();
}

test("runEnvironmentChecksAsync returns the same results as runEnvironmentChecks", async (t) => {
  const dir = makeProject(t, {
    "package.json": JSON.stringify({
      name: "fixture",
      engines: { node: ">=18" },
      scripts: { dev: "vite --port 4321", build: "tsc" },
      devDependencies: { typescript: "^5.0.0" },
    }),
    ".env.example": "API_KEY=\n",
    Dockerfile: "FROM node:20\n",
  });
  mkdirSync(join(dir, "node_modules"), { recursive: true });

  const sync = runEnvironmentChecks(dir);
  const asyncResults = await runEnvironmentChecksAsync(dir);

  assert.deepEqual(
    normalize(asyncResults),
    normalize(sync),
    "async checks must produce the identical result set as the sync checks",
  );
  // Sanity: the fixture is rich enough that the suite actually produced checks.
  assert.ok(sync.length > 0, "expected the fixture to yield environment checks");
});

test("runEnvironmentChecksAsync matches sync on a bare directory (no package.json)", async (t) => {
  const dir = makeProject(t, {});
  const sync = runEnvironmentChecks(dir);
  const asyncResults = await runEnvironmentChecksAsync(dir);
  assert.deepEqual(normalize(asyncResults), normalize(sync));
});

test(
  "single-scan port check detects a real in-use port, identically sync and async",
  { skip: process.platform === "win32" ? "lsof-based port check is macOS/Linux only" : false },
  async (t) => {
    // Bind a real listener, then reference its port from package.json scripts so
    // collectPortsToCheck picks it up. The server stays up across both check runs.
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    assert.ok(port >= 1024 && port <= 65535, "ephemeral port should be in the checked range");

    const dir = makeProject(t, {
      "package.json": JSON.stringify({ name: "fixture", scripts: { dev: `serve --port ${port}` } }),
    });

    const syncConflicts = runEnvironmentChecks(dir).filter((r) => r.name === "port_conflict");
    const asyncConflicts = (await runEnvironmentChecksAsync(dir)).filter((r) => r.name === "port_conflict");

    // Equivalence holds regardless of whether lsof is present on the runner.
    assert.deepEqual(normalize(asyncConflicts), normalize(syncConflicts), "sync and async must agree on port conflicts");
    // On macOS/Linux lsof is standard, so the listener must be reported and named.
    assert.equal(syncConflicts.length, 1, "expected exactly one port conflict for the in-use port");
    assert.match(syncConflicts[0]!.message, new RegExp(`\\b${port}\\b`), "conflict message must name the in-use port");
  },
);
