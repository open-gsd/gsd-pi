// GSD Extension — Guidance module tests
// The catalog is the test surface: every typed finding must resolve to
// non-empty remediation, and load-bearing phrases must survive edits.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  formatGuidance,
  recoveryRemediation,
  needsAttentionBlockerGuidance,
  needsRemediationBlockerGuidance,
  uatSignoffBlockerGuidance,
  worktreeCreationFailedGuidance,
  crashResumeHint,
  doctorFixHint,
  type RecoveryGuidanceKey,
} from "../guidance.js";
import { classifyFailure, type RecoveryFailureKind } from "../recovery-classification.js";
import { isValidationBlockedState } from "../validation-block-guard.js";
import type { GSDState } from "../types.js";

const RECOVERY_KEYS: RecoveryGuidanceKey[] = [
  "tool-schema",
  "tool-contract",
  "tool-unavailable",
  "deterministic-policy",
  "lifecycle-progression",
  "stale-worker",
  "worktree-invalid",
  "verification-drift",
  "reconciliation-drift",
  "illegal-transition",
  "runtime-unknown",
  "provider-transient",
  "provider-permanent",
];

describe("guidance catalog", () => {
  test("every recovery guidance key resolves to non-empty remediation", () => {
    for (const key of RECOVERY_KEYS) {
      const remediation = recoveryRemediation(key);
      assert.ok(remediation.length > 0, `empty remediation for ${key}`);
    }
  });

  test("classifyFailure carries catalog remediation for every failure kind", () => {
    const kinds: RecoveryFailureKind[] = [
      "tool-schema",
      "tool-contract",
      "deterministic-policy",
      "lifecycle-progression",
      "stale-worker",
      "worktree-invalid",
      "verification-drift",
      "reconciliation-drift",
      "runtime-unknown",
    ];
    for (const kind of kinds) {
      const result = classifyFailure({ error: new Error("boom"), failureKind: kind });
      assert.equal(result.failureKind, kind);
      assert.equal(result.exitReason, kind);
      assert.ok(result.remediation.length > 0, `empty remediation for ${kind}`);
    }
  });

  test("escalation kinds with weak guidance now name a concrete command", () => {
    for (const key of ["stale-worker", "worktree-invalid", "verification-drift", "reconciliation-drift"] as const) {
      assert.match(recoveryRemediation(key), /\/gsd /, `no command in remediation for ${key}`);
    }
  });

  test("runtime-unknown names the observed error and recovery options (#1693)", () => {
    const text = recoveryRemediation("runtime-unknown", "ENOENT: missing /tmp/unit.lock");
    assert.match(text, /ENOENT: missing \/tmp\/unit\.lock/);
    assert.match(text, /\/gsd doctor/);
    assert.match(text, /\/gsd auto/);
    assert.match(text, /dedicated recovery classification/);
  });

  test("classifyFailure runtime-unknown remediation includes the thrown message", () => {
    const result = classifyFailure({ error: new Error("unclassified foobar widget") });
    assert.equal(result.failureKind, "runtime-unknown");
    assert.match(result.remediation, /unclassified foobar widget/);
    assert.match(result.remediation, /\/gsd doctor/);
  });

  test("formatGuidance numbers steps under the summary", () => {
    const text = formatGuidance({ summary: "It broke.", steps: ["Fix it.", "Retry."] });
    assert.equal(text, "It broke.\n\n1. Fix it.\n2. Retry.");
  });

  test("formatGuidance with no steps is just the summary", () => {
    assert.equal(formatGuidance({ summary: "All good.", steps: [] }), "All good.");
  });
});

describe("milestone blocker guidance", () => {
  test("needs-attention blocker keeps the phrase the validation-block guard matches", () => {
    const state = { phase: "blocked", blockers: [needsAttentionBlockerGuidance("M005")] } as unknown as GSDState;
    assert.ok(isValidationBlockedState(state));
  });

  test("needs-remediation blocker keeps the phrase the validation-block guard matches", () => {
    const state = { phase: "blocked", blockers: [needsRemediationBlockerGuidance("M005")] } as unknown as GSDState;
    assert.ok(isValidationBlockedState(state));
  });

  test("blockers carry the milestone id and concrete fix commands", () => {
    const text = needsAttentionBlockerGuidance("M007");
    assert.match(text, /M007/);
    assert.match(text, /\/gsd status/);
    assert.match(text, /\/gsd validate-milestone/);
  });

  test("canonical blockers do not recommend the legacy verdict override", () => {
    for (const text of [
      needsAttentionBlockerGuidance("M007", false),
      needsRemediationBlockerGuidance("M007", false),
    ]) {
      assert.doesNotMatch(text, /\/gsd verdict/);
      assert.match(text, /current structured evidence|reassess/i);
    }
  });

  test("UAT sign-off guidance explains direct dispatch target", () => {
    const missing = uatSignoffBlockerGuidance("M007", "S02");
    const failing = uatSignoffBlockerGuidance("M007", "S02", "FAIL");

    for (const text of [missing, failing]) {
      assert.match(text, /Manual UAT sign-off \(PASS\) is required before milestone closure/);
      assert.match(text, /\/gsd dispatch uat/);
      assert.match(text, /most recently completed slice/);
      assert.match(text, /re-run UAT for S02/);
      assert.match(text, /gsd_uat_result_save/);
    }
  });

  test("worktree creation failure guidance does not claim bootstrap continues", () => {
    const text = worktreeCreationFailedGuidance("M007", "boom");

    assert.match(text, /Auto-worktree creation for M007 failed: boom\. Continuing in project root\./);
    assert.match(text, /Worktree isolation is degraded for this session\./);
    assert.doesNotMatch(text, /work continues in the project root/i);
  });
});

describe("crash resume hints", () => {
  test("bootstrap crash reports no work lost", () => {
    assert.match(crashResumeHint("starting", "bootstrap") ?? "", /No work was lost/);
  });

  test("unit classes map to their resume hints", () => {
    assert.match(crashResumeHint("research-milestone", "M001") ?? "", /may be incomplete/);
    assert.match(crashResumeHint("execute-task", "T001") ?? "", /completed work is preserved/);
    assert.match(crashResumeHint("complete-slice", "S001") ?? "", /interrupted/);
  });

  test("unknown unit types yield no hint", () => {
    assert.equal(crashResumeHint("triage-captures", "X"), undefined);
  });
});

describe("doctor fix hints", () => {
  test("known codes resolve to a hint", () => {
    assert.ok(doctorFixHint("stale_crash_lock"));
    assert.ok(doctorFixHint("db_unavailable"));
  });

  test("codes without authored guidance resolve to undefined", () => {
    assert.equal(doctorFixHint("delimiter_in_title"), undefined);
  });

  test("fixable issue codes instruct /gsd doctor fix, not bare /gsd doctor", () => {
    const fixableCodes = [
      "stale_crash_lock",
      "stale_paused_session",
      "stale_parallel_session",
      "orphaned_auto_worktree",
      "gitignore_missing_patterns",
      "state_file_stale",
      "state_file_missing",
      "projection_drift",
    ] as const;

    for (const code of fixableCodes) {
      const hint = doctorFixHint(code);
      assert.ok(hint, `expected a hint for ${code}`);
      assert.match(hint, /\/gsd doctor fix/, `hint for ${code} must use /gsd doctor fix`);
    }
  });

  test("db_unavailable uses bare /gsd doctor (diagnostic only, no auto-fix)", () => {
    const hint = doctorFixHint("db_unavailable");
    assert.ok(hint);
    assert.match(hint, /\/gsd doctor/);
    assert.doesNotMatch(hint, /\/gsd doctor fix/);
  });
});
