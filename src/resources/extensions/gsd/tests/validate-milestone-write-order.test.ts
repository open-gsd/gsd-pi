// Project/App: gsd-pi
// File Purpose: Regression tests for milestone validation persistence and evidence gates.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { handleValidateMilestone } from "../tools/validate-milestone.js";
import { verifyExpectedArtifact } from "../auto-recovery.js";
import { openDatabase, closeDatabase, _getAdapter, insertMilestone, insertSlice, insertArtifact } from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-val-handler-${randomUUID()}`);
  const mDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(mDir, { recursive: true });
  // A content-bearing legacy milestone dir requires at least one non-META file
  // (dirIsContentBearingLegacyMilestone) so the layout sniffer treats it as a
  // real legacy milestone rather than a metadata-only placeholder.
  writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n");
  return base;
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
  let base: string;

  afterEach(() => {
    clearPathCache();
    clearParseCache();
    try { closeDatabase(); } catch { /* */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("writes DB row and disk file on success", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    // DB row exists
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
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(
      { ...VALID_PARAMS, verificationClasses: undefined },
      base,
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.doesNotMatch(validationMd, /## Verification Class Compliance/);
  });

  it("keeps DB row and reports stale projection when disk write fails", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    // Force disk write failure by replacing the milestone directory with a
    // regular file. saveFile() will fail because it cannot write inside a
    // non-directory. This works cross-platform (chmod is ignored on Windows).
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    rmSync(milestoneDir, { recursive: true, force: true });
    writeFileSync(milestoneDir, "not-a-directory");
    // Also block the flat-phase fallback path: write a regular file named
    // "phases" so mkdir("phases/01-m001", {recursive:true}) throws ENOTDIR.
    writeFileSync(join(base, ".gsd", "phases"), "not-a-directory");

    const result = await handleValidateMilestone(VALID_PARAMS, base);

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
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(VALID_PARAMS, base, {
      uokGatesEnabled: true,
      traceId: "trace-val-1",
      turnId: "turn-val-1",
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
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        verificationOperational: "Camoufox subprocess lifecycle/cleanup proof",
      },
    });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(
      { ...VALID_PARAMS, verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |" },
      base,
    );
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
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        verificationContract: "Contract command exits 0",
        verificationOperational: "Process lifecycle proof",
        verificationUat: "Browser-observable UAT proof",
      },
    });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(
      { ...VALID_PARAMS, verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |" },
      base,
    );
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
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        verificationOperational: "Camoufox subprocess lifecycle/cleanup proof",
      },
    });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          "| Class | Planned Check | Evidence | Verdict |\n| --- | --- | --- | --- |\n| Operational | Camoufox subprocess lifecycle/cleanup proof | S01 + process-death evidence | NEEDS-ATTENTION |",
      },
      base,
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  });

  it("treats 'not required - ...' verification values as not applicable", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        verificationOperational: "not required - backend-only",
      },
    });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const result = await handleValidateMilestone(
      { ...VALID_PARAMS, verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |" },
      base,
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  });

  it("downgrades pass to needs-attention when browser criteria lack browser evidence", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: [
          "Clicking Mark All Complete sets all todos completed",
          "Reload keeps completed state",
        ],
        verificationUat: "Open index.html in a browser and click the Mark All Complete button.",
      },
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Open index.html, add todos, click Mark All Complete, reload the page.",
    });

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          `${VALID_PARAMS.verificationClasses}\n- UAT: Browser flow still needs evidence`,
      },
      base,
    );

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "needs-attention");

    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT status FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as { status: string } | undefined;
    assert.equal(row?.status, "needs-attention");

    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.match(validationMd, /verdict: needs-attention/);
    assert.match(validationMd, /Browser evidence gate/);
  });

  it("does not require browser evidence for visible in non-browser prose", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: [
          "Priority scores visible in EmpireMemory",
          "Profitability visible in haul task creation",
        ],
        verificationUat: "Run CLI checks and inspect memory state.",
      },
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

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          `${VALID_PARAMS.verificationClasses}\n- UAT: CLI memory inspection complete`,
      },
      base,
    );

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass when browser criteria have persisted browser evidence", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: [
          "Clicking Mark All Complete sets all todos completed",
          "Reload keeps completed state",
        ],
        verificationUat: "Open index.html in a browser and click the Mark All Complete button.",
      },
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
        "Browser session opened file://index.html, clicked Mark All Complete, asserted the item count text was 0 item(s) left, reloaded, and captured a screenshot.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          `${VALID_PARAMS.verificationClasses}\n- UAT: Browser flow verified by S01 assessment`,
      },
      base,
    );

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
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: [
          "Clicking Mark All Complete sets all todos completed",
          "Reload keeps completed state",
        ],
        verificationUat: "Open index.html in a browser and click the Mark All Complete button.",
      },
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
        "Browser session opened file://index.html, clicked Mark All Complete, verified the remaining-count text was visible, and captured a screenshot.",
        "",
      ].join("\n"),
    });

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          `${VALID_PARAMS.verificationClasses}\n- UAT: Browser flow verified by S01 assessment`,
      },
      base,
    );

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass when persisted browser evidence references a successful batch timeline", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
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
      `Browser evidence: browser:${timelineRef}`,
      "",
    ].join("\n"));

    const result = await handleValidateMilestone({
      ...VALID_PARAMS,
      verificationClasses: `${VALID_PARAMS.verificationClasses}\n- UAT: persisted batch timeline`,
    }, base);

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass when browser-like criteria are verified by runtime-executable UAT", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: [
          "Clicking Mark All Complete sets all todos completed",
          "Reload keeps completed state",
        ],
        verificationUat: "Run the Node.js DOM-state script against the static app source.",
      },
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      // Uses localhost so hasBrowserRequiredText returns true and the gate is
      // actually triggered before the runtime evidence bypasses it.
      demo: "Visit localhost:3000 to verify DOM state after clicking Mark All Complete.",
    });
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(
      join(sliceDir, "S01-ASSESSMENT.md"),
      [
        "---",
        "sliceId: S01",
        "uatType: runtime-executable",
        "verdict: PASS",
        "attempt: 1",
        "---",
        "# UAT Result - S01",
        "",
        "## Checks",
        "",
        "| Check | Mode | Result | Evidence | Notes |",
        "|-------|------|--------|----------|-------|",
        "| DOM-state script | runtime | PASS | gsd_uat_exec:.gsd/evidence/uat/M001/S01/dom-state.json | Runtime assertion verified completed state and reload persistence. |",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          `${VALID_PARAMS.verificationClasses}\n| UAT | Runtime executable UAT verified static-app behavior. |`,
      },
      base,
    );

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("keeps pass for a Contract-only API milestone even when its endpoint is browser-reachable", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: ["The SSE stats endpoint is reachable at localhost:58081."],
        verificationContract: "Contract-check the SSE response schema and streaming behavior.",
      },
    });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Open localhost:58081/admin-api/log/stream/stats to inspect the JSON contract.",
      planning: {
        successCriteria: "The localhost SSE endpoint returns the Contract-defined stats payload.",
      },
    });

    const result = await handleValidateMilestone({
      ...VALID_PARAMS,
      verificationClasses: "| Contract | SSE response schema and streaming checks passed. |",
    }, base);

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });

  it("downgrades to needs-attention when only one of two browser-requiring slices has runtime evidence", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      demo: "Visit localhost:3000 to verify DOM state.",
    });
    insertSlice({
      id: "S02",
      milestoneId: "M001",
      demo: "Visit localhost:3000 to confirm persistence after reload.",
    });
    // S01 has runtime-executable evidence; S02 has none.
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md"),
      [
        "---",
        "sliceId: S01",
        "uatType: runtime-executable",
        "verdict: PASS",
        "---",
        "| DOM check | runtime | PASS | gsd_uat_exec:.gsd/evidence/uat/M001/S01/dom.json | Verified. |",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses: `${VALID_PARAMS.verificationClasses}\n| UAT | S01 runtime verified; S02 still needs evidence. |`,
      },
      base,
    );

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(
      result.verdict,
      "needs-attention",
      "S01 runtime evidence must not bypass the gate for S02 which has browser requirements but no evidence",
    );
  });

  it("ignores slice full_uat_md planning text for browser requirement detection", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({
      id: "M001",
      planning: {
        successCriteria: [
          "CLI command exits zero",
          "Unit tests pass",
        ],
        verificationUat: "Run CLI checks and inspect logs.",
      },
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

    const result = await handleValidateMilestone(
      {
        ...VALID_PARAMS,
        verificationClasses:
          `${VALID_PARAMS.verificationClasses}\n- UAT: CLI-only checks complete`,
      },
      base,
    );

    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.verdict, "pass");
  });
});
