// Project/App: gsd-pi
// File Purpose: Regression tests for milestone validation persistence and the
// structured browser-evidence gate.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { handleValidateMilestone, type ValidateMilestoneParams } from "../tools/validate-milestone.js";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.js";
import { verifyExpectedArtifact } from "../auto-recovery.js";
import { openDatabase, closeDatabase, _getAdapter, insertMilestone, insertSlice, insertArtifact } from "../gsd-db.js";
import { seedLifecycles } from "./helpers/authority-cutover.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-val-handler-${randomUUID()}`);
  const mDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n");
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
  execFileSync("git", ["add", ".gitignore"], { cwd: base });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: base, stdio: "ignore" });
  return base;
}

/** Open the DB and adopt the fixture rows so the canonical validation records. */
function seedAdoptedMilestone(
  projectBase: string,
  planning?: Record<string, unknown>,
  slices: Array<Parameters<typeof insertSlice>[0]> = [{ id: "S01", milestoneId: "M001" }],
): void {
  openDatabase(join(projectBase, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    title: "Validation",
    ...(planning ? { planning } : {}),
  } as Parameters<typeof insertMilestone>[0]);
  for (const slice of slices) insertSlice(slice);
  seedLifecycles(`validate-write-order/${randomUUID()}`, [
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" },
    ...slices.map((slice) => ({
      itemKind: "slice" as const,
      milestoneId: "M001",
      sliceId: slice.id,
      lifecycleStatus: "completed" as const,
    })),
  ]);
}

function invocation(key: string) {
  return {
    invocation: {
      idempotencyKey: `test/validate-write-order/${key}`,
      sourceTransport: "internal" as const,
      actorType: "agent" as const,
    },
  };
}

const uatEvidence = (sliceId: string, evidenceClass: "browser" | "runtime" = "browser") => ({
  verificationClass: "UAT" as const,
  evidenceClass,
  commandOrTool: evidenceClass === "runtime" ? "gsd_uat_exec" : "browser acceptance journey",
  workingDirectory: ".",
  startedAt: "2026-07-14T10:00:00.000Z",
  endedAt: "2026-07-14T10:01:00.000Z",
  observation: "passed" as const,
  durableOutputRef: "artifact://uat/evidence",
  environment: { evidence: "artifact://uat/evidence" },
  sliceId,
  rationale: "Verified.",
  testedSourceRevision: "sha256:fixture",
});

const classEvidence = (className: "Contract" | "Integration" | "Operational" | "UAT") => ({
  verificationClass: className,
  evidenceClass: "command" as const,
  commandOrTool: "check",
  workingDirectory: ".",
  startedAt: "2026-07-14T10:00:00.000Z",
  endedAt: "2026-07-14T10:01:00.000Z",
  exitCode: 0,
  observation: "passed" as const,
  durableOutputRef: "artifact://class/evidence",
  environment: { evidence: "artifact://class/evidence" },
  rationale: "Verified.",
  testedSourceRevision: "sha256:fixture",
});

async function validate(projectBase: string, params: Partial<ValidateMilestoneParams>, key = "default") {
  // Structured evidence must be tested against the current source revision.
  const source = captureMilestoneVerificationSourceRevision(projectBase, undefined);
  assert.ok(source.ok, "fixture must be able to capture its source revision");
  const evidence = (params.verificationEvidence ?? []).map((entry) => ({
    ...entry,
    testedSourceRevision: source.sourceRevision,
  }));
  if (process.env.GSD_DEBUG_EVIDENCE) console.log("EVIDENCE", JSON.stringify(evidence));
  return handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] All pass",
    sliceDeliveryAudit: "| S01 | delivered |",
    crossSliceIntegration: "No issues",
    requirementCoverage: "All covered",
    verificationClasses: "- Contract: covered\n- Integration: covered\n- Operational: gap noted",
    verdictRationale: "Everything checks out",
    ...params,
    ...(params.verificationEvidence ? { verificationEvidence: evidence } : {}),
  }, projectBase, invocation(key));
}

const VALID_PARAMS = {
  milestoneId: "M001",
  verdict: "pass" as const,
  remediationRound: 0,
  successCriteriaChecklist: "- [x] All pass",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "No issues",
  requirementCoverage: "All covered",
  verificationClasses: "- Contract: covered\n- Integration: covered\n- Operational: gap noted",
  verdictRationale: "Everything checks out",
};

describe("handleValidateMilestone write ordering (#2725)", () => {
  let base: string | undefined;

  afterEach(() => {
    clearPathCache();
    clearParseCache();
    try { closeDatabase(); } catch { /* */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    }
    base = undefined;
  });

  it("requires canonical invocation identity", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(VALID_PARAMS, base);
    assert.ok("error" in result);
    assert.match(result.error, /canonical invocation identity/);
  });

  it("writes DB row and disk file on success", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base);

    const result = await validate(base, {});
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    // DB row exists (the canonical operation records the assessment row)
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status, scope FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string; scope: string } | undefined;
    assert.ok(row, "assessment row should exist in DB");
    assert.equal(row!.status, "pass");

    // Disk file exists
    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.ok(existsSync(filePath), "VALIDATION.md should exist on disk");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.match(validationMd, /## Verification Class Compliance/);
    assert.match(validationMd, /- Contract: covered/);
    assert.match(validationMd, /## Verdict Rationale/);
  });

  it("omits verification class section when no verification classes are supplied", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base);

    const result = await validate(base, { verificationClasses: undefined });
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.doesNotMatch(validationMd, /## Verification Class Compliance/);
  });

  it("keeps DB row and reports stale projection when disk write fails", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base);

    // Force disk write failure by replacing the milestone directory with a
    // regular file. saveFile() will fail because it cannot write inside a
    // non-directory. This works cross-platform (chmod is ignored on Windows).
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    rmSync(milestoneDir, { recursive: true, force: true });
    writeFileSync(milestoneDir, "not-a-directory");
    // Also block the flat-phase fallback path: write a regular file named
    // "phases" so mkdir("phases/01-m001", {recursive:true}) throws ENOTDIR.
    writeFileSync(join(base, ".gsd", "phases"), "not-a-directory");

    const result = await validate(base, {});

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.stale, true, "result should report stale projection");

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string } | undefined;
    assert.ok(row, "assessment row should remain committed");
    assert.equal(row!.status, "pass");
    assert.equal(
      verifyExpectedArtifact("validate-milestone", "M001", base),
      true,
      "auto-mode must trust the committed validation when its Markdown projection is stale",
    );
  });

  it("persists milestone validation gate_runs rows when UOK gates are enabled", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base);

    const result = await handleValidateMilestone(VALID_PARAMS, base, {
      uokGatesEnabled: true,
      traceId: "trace-val-1",
      turnId: "turn-val-1",
      ...invocation("uok"),
    });
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT gate_id, outcome, failure_class, trace_id, turn_id
       FROM gate_runs
       WHERE gate_id = 'milestone-validation-gates'
       ORDER BY id DESC
       LIMIT 1`,
    ).get() as
      | {
          gate_id: string;
          outcome: string;
          failure_class: string;
          trace_id: string;
          turn_id: string;
        }
      | undefined;

    assert.ok(row, "milestone validation gate row should be persisted");
    assert.equal(row?.gate_id, "milestone-validation-gates");
    assert.equal(row?.outcome, "pass");
    assert.equal(row?.failure_class, "none");
    assert.equal(row?.trace_id, "trace-val-1");
    assert.equal(row?.turn_id, "turn-val-1");
  });

  it("rejects verificationClasses that omit planned Operational class", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      verificationOperational: "Camoufox subprocess lifecycle/cleanup proof",
    });

    const result = await validate(base, {
      verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |",
    });
    assert.ok("error" in result, "expected validation to fail");
    assert.match(result.error, /must include canonical row "Operational"/);

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string } | undefined;
    assert.equal(row, undefined, "assessment row should not be written when verification classes are invalid");
  });

  it("reports all missing planned verification class rows at once", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      verificationContract: "Contract command exits 0",
      verificationOperational: "Process lifecycle proof",
      verificationUat: "Browser-observable UAT proof",
    });

    const result = await validate(base, {
      verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |",
    });
    assert.ok("error" in result, "expected validation to fail");
    assert.match(result.error, /canonical rows "Contract", "Operational", "UAT"/);
    assert.match(result.error, /planned contract, operational, uat verification/);

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string } | undefined;
    assert.equal(row, undefined, "assessment row should not be written when verification classes are invalid");
  });

  it("accepts verificationClasses when planned Operational class is present", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      verificationOperational: "Camoufox subprocess lifecycle/cleanup proof",
    });

    const result = await validate(base, {
      verificationClasses:
        "| Class | Planned Check | Evidence | Verdict |\n| --- | --- | --- | --- |\n| Operational | Camoufox subprocess lifecycle/cleanup proof | S01 + process-death evidence | NEEDS-ATTENTION |",
      verificationEvidence: [classEvidence("Operational")],
    }, "operational-present");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  });

  it("treats 'not required - ...' verification values as not applicable", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      verificationOperational: "not required - backend-only",
    });

    const result = await validate(base, {
      verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |",
    }, "not-required");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  });

  it("rejects pass when browser criteria lack qualifying browser evidence", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: [
        "Clicking Mark All Complete sets all todos completed",
        "Reload keeps completed state",
      ],
      verificationUat: "Open index.html in a browser and click the Mark All Complete button.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Open index.html, add todos, click Mark All Complete, reload the page.",
    });

    const result = await validate(base, {
      verificationClasses:
        `${VALID_PARAMS.verificationClasses}\n- UAT: Browser flow still needs evidence`,
    }, "browser-missing");

    assert.ok("error" in result, "browser-required pass without evidence must be rejected");
    if ("error" in result) {
      assert.match(result.error, /browser-required acceptance needs passed UAT browser\/runtime evidence/);
      assert.match(result.error, /Missing: S01\./);
    }
  });

  it("does not require browser evidence for visible in non-browser prose", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: [
        "Priority scores visible in EmpireMemory",
        "Profitability visible in haul task creation",
      ],
      verificationUat: "Run CLI checks and inspect memory state.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Priority scores visible in EmpireMemory after worker planning.",
      planning: {
        goal: "Expose runtime scoring in memory for operator inspection.",
        successCriteria: "Memory fields are available for CLI inspection.",
      },
    });

    const result = await validate(base, {
      verificationClasses:
        `${VALID_PARAMS.verificationClasses}\n- UAT: CLI memory inspection complete`,
      verificationEvidence: [uatEvidence("S01")],
    }, "non-browser");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass when browser criteria have persisted structured browser evidence", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: [
        "Clicking Mark All Complete sets all todos completed",
        "Reload keeps completed state",
      ],
      verificationUat: "Open index.html in a browser and click the Mark All Complete button.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Open index.html, add todos, click Mark All Complete, reload the page.",
    });
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(
      join(sliceDir, "S01-ASSESSMENT.md"),
      [
        "---",
        "verdict: PASS",
        "---",
        "# UAT Result",
        "",
        "| Check | Mode | Result | Evidence |",
        "| --- | --- | --- | --- |",
        "| Mark All Complete | browser | PASS | browser:.artifacts/browser/session/todos.json |",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await validate(base, {
      verificationClasses:
        `${VALID_PARAMS.verificationClasses}\n- UAT: Browser flow verified by S01 assessment`,
      verificationEvidence: [uatEvidence("S01")],
    }, "persisted-file");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string } | undefined;
    assert.equal(row?.status, "pass");
  });

  it("keeps pass when browser evidence is persisted in the DB artifact", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: [
        "Clicking Mark All Complete sets all todos completed",
        "Reload keeps completed state",
      ],
      verificationUat: "Open index.html in a browser and click the Mark All Complete button.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Open index.html, add todos, click Mark All Complete, reload the page.",
    });
    insertArtifact({
      path: "milestones/M001/slices/S01/S01-ASSESSMENT.md",
      artifact_type: "ASSESSMENT",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: null,
      full_content: [
        "---",
        "verdict: PASS",
        "---",
        "# UAT Result",
        "",
        "| Check | Mode | Result | Evidence |",
        "| --- | --- | --- | --- |",
        "| Mark All Complete | browser | PASS | browser:.artifacts/browser/session/todos.json |",
        "",
      ].join("\n"),
    });

    const result = await validate(base, {
      verificationClasses:
        `${VALID_PARAMS.verificationClasses}\n- UAT: Browser flow verified by S01 assessment`,
      verificationEvidence: [uatEvidence("S01")],
    }, "persisted-db");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass when persisted browser evidence references a successful batch timeline", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      planning: { verificationUat: "Navigate through the browser acceptance check." },
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Visit localhost:58081 and verify the stats response.",
    });
    const timelineRef = ".artifacts/browser/session/sse-stats.json";
    mkdirSync(join(base, ".artifacts", "browser", "session"), { recursive: true });
    writeFileSync(join(base, timelineRef), JSON.stringify({
      entries: [{
        tool: "browser_batch",
        status: "success",
        batchSteps: [
          { action: "navigate", ok: true },
          { action: "assert", ok: true },
        ],
      }],
    }));
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-ASSESSMENT.md"), [
      "---",
      "verdict: PASS",
      "---",
      "",
      "| Check | Mode | Result | Evidence |",
      "| --- | --- | --- | --- |",
      `| Stats response | browser | PASS | browser:${timelineRef} |`,
      "",
    ].join("\n"));

    const result = await validate(base, {
      verificationClasses: `${VALID_PARAMS.verificationClasses}\n- UAT: persisted batch timeline`,
      verificationEvidence: [uatEvidence("S01")],
    }, "timeline");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass when browser-like criteria are verified by bound runtime-executable UAT evidence", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: [
        "Clicking Mark All Complete sets all todos completed",
        "Reload keeps completed state",
      ],
      verificationUat: "Run the Node.js DOM-state script against the static app source.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      // Uses localhost so hasBrowserRequiredText returns true and the gate is
      // actually exercised before the bound runtime evidence satisfies it.
      demo: "Visit localhost:3000 to verify DOM state after clicking Mark All Complete.",
    });

    const result = await validate(base, {
      verificationClasses:
        `${VALID_PARAMS.verificationClasses}\n| UAT | Runtime executable UAT verified static-app behavior. |`,
      verificationEvidence: [{
        verificationClass: "UAT",
        evidenceClass: "runtime",
        commandOrTool: "gsd_uat_exec",
        workingDirectory: ".",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T10:01:00.000Z",
        observation: "passed",
        durableOutputRef: "artifact://uat/dom-state",
        environment: { evidence: "artifact://uat/dom-state" },
        sliceId: "S01",
        rationale: "DOM-state script asserted completed state and reload persistence.",
        testedSourceRevision: "sha256:fixture",
      }],
    }, "runtime-bound");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass for a Contract-only API milestone even when its endpoint is browser-reachable", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: ["The SSE stats endpoint is reachable at localhost:58081."],
      verificationContract: "Contract-check the SSE response schema and streaming behavior.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Open localhost:58081/admin-api/log/stream/stats to inspect the JSON contract.",
      planning: {
        successCriteria: "The localhost SSE endpoint returns the Contract-defined stats payload.",
      },
    });

    const result = await validate(base, {
      verificationClasses: "| Contract | SSE response schema and streaming checks passed. |",
      verificationEvidence: [classEvidence("Contract")],
    }, "contract-only");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("rejects pass when only one of two browser-requiring slices has qualifying evidence", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {}, [
      { id: "S01", milestoneId: "M001", demo: "Visit localhost:3000 to verify DOM state." },
      { id: "S02", milestoneId: "M001", demo: "Visit localhost:3000 to confirm persistence after reload." },
    ]);

    const result = await validate(base, {
      verificationClasses: `${VALID_PARAMS.verificationClasses}\n| UAT | S01 runtime verified; S02 still needs evidence. |`,
      verificationEvidence: [{
        verificationClass: "UAT",
        evidenceClass: "runtime",
        commandOrTool: "gsd_uat_exec",
        workingDirectory: ".",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T10:01:00.000Z",
        observation: "passed",
        durableOutputRef: "artifact://uat/dom-check",
        environment: { evidence: "artifact://uat/dom-check" },
        sliceId: "S01",
        rationale: "DOM check verified.",
        testedSourceRevision: "sha256:fixture",
      }],
    }, "partial-evidence");

    assert.ok("error" in result, "uncovered browser-required slices must reject a pass");
    if ("error" in result) {
      assert.match(result.error, /Missing: S02\./);
    }
  });

  it("ignores slice full_uat_md planning text for browser requirement detection", async () => {
    base = makeTmpBase();
    seedAdoptedMilestone(base, {
      successCriteria: [
        "CLI command exits zero",
        "Unit tests pass",
      ],
      verificationUat: "Run CLI checks and inspect logs.",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Run npm test and npm run build.",
    });

    const adapter = _getAdapter()!;
    adapter.prepare(
      `UPDATE slices SET full_uat_md = :uat WHERE milestone_id = 'M001' AND id = 'S01'`,
    ).run({
      ":uat": [
        "# S01 UAT",
        "",
        "Current zero-warning state is a snapshot after cleanup.",
        "Reload service and verify visible logs in CLI output.",
        "DOM snapshot checks are optional in unit tests.",
      ].join("\n"),
    });

    const result = await validate(base, {
      verificationClasses:
        `${VALID_PARAMS.verificationClasses}\n- UAT: CLI-only checks complete`,
      verificationEvidence: [uatEvidence("S01")],
    }, "full-uat-md");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });
});
