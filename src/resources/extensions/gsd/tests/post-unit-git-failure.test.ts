import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSourceRegion } from "./test-helpers.ts";

const source = readFileSync(
  join(import.meta.dirname, "..", "auto-post-unit.ts"),
  "utf-8",
);

test("postUnitPreVerification blocks on non-transient git action failure", () => {
  const failureBlock = extractSourceRegion(source, 'if (gitResult.status === "failed")');
  // Deterministic / unknown git failures still pause auto-mode instead of silently continuing.
  assert.ok(failureBlock.includes('ctx.ui.notify(failureMsg, "error")'));
  assert.ok(failureBlock.includes("await pauseAuto(ctx, pi)"));
  assert.ok(failureBlock.includes('return "dispatched"'));
  // Only transient failures are allowed to warn-and-continue under softFailure.
  assert.ok(failureBlock.includes('if (opts?.softFailure && gitResult.failureClass === "transient")'));
  assert.ok(failureBlock.includes('return "continue"'));
  // Deterministic pre-commit hook rejections on execute-task commits route into bounded remediation retries.
  assert.ok(failureBlock.includes('gitResult.failureClass === "hook-content"'));
  assert.ok(failureBlock.includes('return "retry"'));
  assert.ok(!failureBlock.includes("git-action-failed-nonblocking"));
});

test("buildTaskCommitContextForUnit filters placeholder key_files entries", () => {
  const keyFilesBlock = extractSourceRegion(source, "keyFiles:");
  assert.ok(keyFilesBlock.includes("normalized.length > 0"));
  assert.ok(keyFilesBlock.includes("!normalized.includes(\"{{\")"));
  assert.ok(keyFilesBlock.includes("/^(?:\\(none\\)|none\\.?|n\\/a)$/i.test(normalized)"));
});
