// Real public-entry regressions for cancellation followed by a rejected startup await.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const [mode, title] of [
  ["resume", "resume startup cannot continue after a cancelled awaited operation rejects"],
  ["fresh", "fresh startup cannot continue after a cancelled awaited operation rejects"],
  ["deferred", "stop cancels a guided idle fallback after its original public startup finishes"],
  ["deferred-normal", "an uncancelled guided idle fallback still launches after its original public startup finishes"],
] as const) {
  test(title, { timeout: 75_000 }, () => {
    const source = import.meta.url.endsWith(".ts");
    const fixture = new URL(`./helpers/auto-startup-rejection.fixture.${source ? "ts" : "js"}`, import.meta.url);
    let root = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(root, "scripts", "dist-test-resolve.mjs"))) {
      const parent = dirname(root);
      assert.notEqual(parent, root, "repository test resolver must exist");
      root = parent;
    }
    const output = execFileSync(process.execPath, [
      "--experimental-test-module-mocks", "--import",
      source ? "tsx" : join(root, "scripts", "dist-test-resolve.mjs"),
      fileURLToPath(fixture), mode,
    ], { cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(output, /"passed":true/, "isolated fixture must complete all cancellation assertions");
  });
}
