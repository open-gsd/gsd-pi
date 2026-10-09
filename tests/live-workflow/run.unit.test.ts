import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "run.ts");

function runWithoutCredentials(extraEnv: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", runner], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GSD_LIVE_TESTS: "1", ...extraEnv },
  });
}

test("an all-skip run exits 0 without GSD_LIVE_WORKFLOW_REQUIRE_PASS", () => {
  const result = runWithoutCredentials({});

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 passed, 0 failed, [1-9]\d* skipped/);
});

test("an all-skip run exits 1 with GSD_LIVE_WORKFLOW_REQUIRE_PASS=1", () => {
  const result = runWithoutCredentials({ GSD_LIVE_WORKFLOW_REQUIRE_PASS: "1" });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /0 passed, 0 failed, [1-9]\d* skipped/);
  assert.match(result.stderr, /no live scenario ran; check the provider credential/);
});
