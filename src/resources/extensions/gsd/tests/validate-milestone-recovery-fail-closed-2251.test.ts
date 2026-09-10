// Project/App: gsd-pi
// File Purpose: Regression coverage for #2251 — exhausted validate-milestone
// recovery must pause fail-closed instead of writing a blocker placeholder
// into the canonical VALIDATION.md projection, and recovery messaging must
// never claim a canonical validation result was persisted when none was.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
} from "../auto-recovery.ts";
import { normalizeRealPath } from "../paths.ts";
import { recoverTimedOutUnit, type RecoveryContext } from "../auto-timeout-recovery.ts";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../unit-runtime.ts";
import {
  closeDatabase,
  getMilestone,
  insertMilestone,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-validate-fail-closed-2251-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function cleanupBase(base: string): void {
  if (isDbAvailable()) closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function recoveryContext(base: string, startedAt: number): RecoveryContext {
  return {
    basePath: base,
    verbose: false,
    currentUnitStartedAt: startedAt,
    unitRecoveryCount: new Map(),
  };
}

/** Open a DB with an active M001 that has NO canonical validation verdict, and seed exhausted recovery attempts. */
function seedExhaustedRecovery(base: string): number {
  const startedAt = Date.now();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  writeUnitRuntimeRecord(base, "validate-milestone", "M001", startedAt, {
    recoveryAttempts: 2,
  });
  return startedAt;
}

test("#2251: exhausted validate-milestone recovery pauses fail-closed instead of clobbering the canonical VALIDATION projection", async (t) => {
  const base = createBase();
  t.after(() => cleanupBase(base));
  const startedAt = seedExhaustedRecovery(base);
  const validationPath = resolveExpectedArtifactPath("validate-milestone", "M001", base)!;
  const blockerPath = validationPath.replace(/-VALIDATION\.md$/u, "-RECOVERY-BLOCKER.md");
  const notifications: string[] = [];
  const messages: unknown[] = [];

  const result = await recoverTimedOutUnit(
    { ui: { notify: (message: string) => notifications.push(message) } } as any,
    { sendMessage: (message: unknown) => messages.push(message) } as any,
    "validate-milestone",
    "M001",
    "idle",
    recoveryContext(base, startedAt),
  );

  assert.equal(result, "paused", "exhausted validation recovery must stop fail-closed");
  assert.equal(
    readUnitRuntimeRecord(base, "validate-milestone", "M001")?.phase,
    "paused",
    "the runtime record must show the unit paused, not skipped",
  );
  assert.equal(
    existsSync(validationPath),
    false,
    "the canonical VALIDATION projection must never be created by recovery",
  );
  assert.equal(existsSync(blockerPath), false, "the timeout pause must not fabricate an artifact");
  assert.equal(
    getMilestone("M001")?.status,
    "active",
    "recovery must leave milestone authority unchanged",
  );
  assert.equal(messages.length, 0, "exhaustion must not schedule another model turn");
  assert.equal(notifications.filter((message) => message.includes("recovery exhausted")).length, 1);
  assert.equal(notifications.some((message) => message.includes("Advancing pipeline")), false);
});

test("#2251: writeBlockerPlaceholder for validate-milestone never occupies the canonical VALIDATION path", (t) => {
  const base = createBase();
  t.after(() => cleanupBase(base));
  const validationPath = resolveExpectedArtifactPath("validate-milestone", "M001", base)!;
  const blockerPath = validationPath.replace(/-VALIDATION\.md$/u, "-RECOVERY-BLOCKER.md");
  const persisted = "# M001 validation\n\nverdict: needs-attention\n";
  writeFileSync(validationPath, persisted, "utf-8");

  const result = writeBlockerPlaceholder(
    "validate-milestone",
    "M001",
    base,
    "deterministic policy rejection",
  );

  assert.equal(
    result,
    join(".gsd", "milestones", "M001", "M001-RECOVERY-BLOCKER.md"),
    "must return the actually-written sibling path",
  );
  assert.doesNotMatch(
    result ?? "",
    /gsd_validate_milestone/u,
    "the returned location must not be expected-artifact prose",
  );
  assert.equal(
    readFileSync(validationPath, "utf-8"),
    persisted,
    "the canonical VALIDATION projection must remain untouched",
  );
  assert.match(readFileSync(blockerPath, "utf-8"), /deterministic policy rejection/u);
});

test("#2251: writeBlockerPlaceholder for complete-milestone never occupies the canonical SUMMARY projection", (t) => {
  const base = createBase();
  t.after(() => cleanupBase(base));
  const summaryPath = resolveExpectedArtifactPath("complete-milestone", "M001", base)!;
  const blockerPath = summaryPath.replace(/-SUMMARY\.md$/u, "-RECOVERY-BLOCKER.md");
  const persisted = "# M001 summary (partial)\n";
  writeFileSync(summaryPath, persisted, "utf-8");

  const result = writeBlockerPlaceholder("complete-milestone", "M001", base, "retries exhausted");

  assert.equal(
    result,
    join(".gsd", "milestones", "M001", "M001-RECOVERY-BLOCKER.md"),
    "must return the actually-written sibling path",
  );
  assert.equal(
    readFileSync(summaryPath, "utf-8"),
    persisted,
    "the canonical SUMMARY projection must remain untouched",
  );
  assert.match(readFileSync(blockerPath, "utf-8"), /retries exhausted/u);
});

test("#2251: writeBlockerPlaceholder returns null when the canonical path does not match the sidecar rename suffix", (t) => {
  const base = createBase();
  t.after(() => cleanupBase(base));
  // paths.ts resolveFile's legacy fallback resolves a bare `VALIDATION.md`
  // (no `<MID>-`/phase prefix), which does not match the `-VALIDATION.md$`
  // sidecar rename. The bail-out must force the pause fallback (null) and
  // leave that canonical projection untouched.
  const legacyValidationPath = join(base, ".gsd", "milestones", "M001", "VALIDATION.md");
  const persisted = "# M001 validation (legacy layout)\n\nverdict: pass\n";
  writeFileSync(legacyValidationPath, persisted, "utf-8");
  assert.equal(
    resolveExpectedArtifactPath("validate-milestone", "M001", base),
    normalizeRealPath(legacyValidationPath),
    "fixture must resolve the legacy-named file as the canonical artifact",
  );

  const result = writeBlockerPlaceholder("validate-milestone", "M001", base, "retries exhausted");

  assert.equal(result, null, "a non-renameable canonical path must bail out to the pause fallback");
  assert.equal(
    readFileSync(legacyValidationPath, "utf-8"),
    persisted,
    "the canonical VALIDATION projection must remain untouched",
  );
});

test("#2251: writeBlockerPlaceholder returns a sidecar path that resolves through a symlinked base", (t) => {
  const base = createBase();
  const linkParent = mkdtempSync(join(tmpdir(), "gsd-validate-fail-closed-2251-link-"));
  const linkedBase = join(linkParent, "linked-base");
  symlinkSync(base, linkedBase, "dir");
  t.after(() => {
    cleanupBase(base);
    rmSync(linkParent, { recursive: true, force: true });
  });
  const validationPath = resolveExpectedArtifactPath("validate-milestone", "M001", base)!;
  const persisted = "# M001 validation\n";
  writeFileSync(validationPath, persisted, "utf-8");

  const result = writeBlockerPlaceholder("validate-milestone", "M001", linkedBase, "retries exhausted");

  assert.equal(
    result,
    join(".gsd", "milestones", "M001", "M001-RECOVERY-BLOCKER.md"),
    "the returned path must be clean relative to the real base, not a ..-escapes artifact",
  );
  assert.doesNotMatch(result ?? "", /\.\./u, "the returned path must not escape via symlink segments");
  const sidecar = join(normalizeRealPath(linkedBase), result ?? "");
  assert.equal(existsSync(sidecar), true, "the returned path must resolve to the written sidecar");
  assert.match(readFileSync(sidecar, "utf-8"), /retries exhausted/u);
  assert.equal(
    readFileSync(validationPath, "utf-8"),
    persisted,
    "the canonical VALIDATION projection must remain untouched",
  );
});

test("#2251: exhausted validate-milestone recovery never reports a canonical result as persisted", async (t) => {
  const base = createBase();
  t.after(() => cleanupBase(base));
  const startedAt = seedExhaustedRecovery(base);
  const notifications: string[] = [];
  const messages: unknown[] = [];

  const result = await recoverTimedOutUnit(
    { ui: { notify: (message: string) => notifications.push(message) } } as any,
    { sendMessage: (message: unknown) => messages.push(message) } as any,
    "validate-milestone",
    "M001",
    "hard",
    recoveryContext(base, startedAt),
  );
  assert.equal(messages.length, 0, "exhaustion must not schedule another model turn");

  assert.equal(result, "paused", "exhausted hard-timeout validation recovery must stop fail-closed");
  assert.equal(
    readUnitRuntimeRecord(base, "validate-milestone", "M001")?.phase,
    "paused",
    "the runtime record must show the unit paused, not skipped",
  );
  assert.ok(notifications.length > 0, "recovery must notify the operator");
  for (const message of notifications) {
    assert.doesNotMatch(
      message,
      /persisted via gsd_validate_milestone/u,
      "recovery must not claim a canonical validation result was persisted",
    );
    assert.equal(
      message.includes("Advancing pipeline"),
      false,
      "recovery must not report that the pipeline advanced",
    );
  }
});
