// Project/App: gsd-pi
// File Purpose: Gate test that unit completion and dispatch decide from DB rows, never from projection files.

/**
 * ADR-046: the workflow database is the authority. For each unit type:
 *   (a) DB evidence present, every projection file absent  → complete / advance
 *   (b) every projection file present and well formed, no DB evidence → incomplete
 *
 * A projection file never proves completion and a missing file never blocks it.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact, writeBlockerPlaceholder } from "../auto-recovery.ts";
import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { DISPATCH_RULES, type DispatchAction, type DispatchContext } from "../auto-dispatch.ts";
import { evaluateGuardedCompleteMilestoneDispatch } from "../milestone-closeout.ts";
import { closeQualityGatesFromEvidence } from "../quality-gate-closure.ts";
import {
  closeDatabase,
  getPendingGates,
  hasUnitRecoveryBlock,
  insertArtifact,
  insertAssessment,
  insertGateRow,
  insertMilestone,
  insertReplanHistory,
  insertSlice,
  insertTask,
  openDatabase,
  setSliceSketchFlag,
  setSliceUatMd,
  updateMilestoneStatus,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";
import type { GSDPreferences } from "../preferences.ts";
import type { GSDState } from "../types.ts";

const MID = "M001";
const SID = "S01";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gsd-completion-evidence-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: MID, title: "Evidence", status: "active" });
});

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

function milestoneDir(): string {
  return join(base, ".gsd", "milestones", MID);
}

function sliceDir(): string {
  return join(milestoneDir(), "slices", SID);
}

function writeFile(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n"));
}

function saveArtifact(type: string, sliceId: string | null): void {
  insertArtifact({
    path: sliceId ? `milestones/${MID}/slices/${sliceId}/${sliceId}-${type}.md` : `milestones/${MID}/${MID}-${type}.md`,
    artifact_type: type,
    milestone_id: MID,
    slice_id: sliceId,
    task_id: null,
    full_content: `# ${type}\n\nSaved through the tool.\n`,
  });
}

interface UnitCase {
  unitType: string;
  unitId: string;
  /** Rows the unit works on. They are not the unit's result. */
  setup?: () => void;
  /** The rows that the unit's save tool commits. */
  recordResult: () => void;
  /** Every projection file of the unit, well formed. */
  writeProjections: () => void;
}

const PLAN_LINES = [
  `# ${SID}: Slice`,
  "",
  "## Tasks",
  "",
  "- [ ] **T01: First task** `est:1h`",
  "",
];

const UNIT_CASES: UnitCase[] = [
  {
    unitType: "discuss-milestone",
    unitId: MID,
    recordResult: () => saveArtifact("CONTEXT", null),
    writeProjections: () => writeFile(join(milestoneDir(), `${MID}-CONTEXT.md`), ["# Context", "", "Decisions."]),
  },
  {
    unitType: "research-milestone",
    unitId: MID,
    recordResult: () => saveArtifact("RESEARCH", null),
    writeProjections: () => writeFile(join(milestoneDir(), `${MID}-RESEARCH.md`), ["# Research", "", "Findings."]),
  },
  {
    unitType: "plan-milestone",
    unitId: MID,
    recordResult: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" }),
    writeProjections: () => writeFile(join(milestoneDir(), `${MID}-ROADMAP.md`), [
      `# ${MID}: Evidence`,
      "",
      "## Slices",
      "",
      `- [ ] **${SID}: Slice** \`risk:low\` \`depends:[]\``,
      "",
    ]),
  },
  {
    unitType: "discuss-slice",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" }),
    recordResult: () => saveArtifact("CONTEXT", SID),
    writeProjections: () => writeFile(join(sliceDir(), `${SID}-CONTEXT.md`), ["# Slice context", "", "Decisions."]),
  },
  {
    unitType: "research-slice",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" }),
    recordResult: () => saveArtifact("RESEARCH", SID),
    writeProjections: () => writeFile(join(sliceDir(), `${SID}-RESEARCH.md`), ["# Slice research", "", "Findings."]),
  },
  {
    unitType: "plan-slice",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" }),
    recordResult: () => insertTask({ id: "T01", sliceId: SID, milestoneId: MID, title: "First task", status: "pending" }),
    writeProjections: () => {
      writeFile(join(sliceDir(), `${SID}-PLAN.md`), PLAN_LINES);
      writeFile(join(sliceDir(), "tasks", "T01-PLAN.md"), ["# T01: First task", "", "## Steps", "", "1. Do it."]);
    },
  },
  {
    unitType: "refine-slice",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending", isSketch: true }),
    recordResult: () => {
      setSliceSketchFlag(MID, SID, false);
      insertTask({ id: "T01", sliceId: SID, milestoneId: MID, title: "First task", status: "pending" });
    },
    writeProjections: () => writeFile(join(sliceDir(), `${SID}-PLAN.md`), PLAN_LINES),
  },
  {
    unitType: "reassess-roadmap",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" }),
    recordResult: () => insertAssessment({
      path: `milestones/${MID}/${MID}-ROADMAP-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SID,
      status: "pass",
      scope: "roadmap",
      fullContent: "Roadmap is fine.",
    }),
    writeProjections: () => writeFile(join(milestoneDir(), `${MID}-ROADMAP-ASSESSMENT.md`), ["---", "verdict: pass", "---", "", "Roadmap is fine."]),
  },
  {
    unitType: "replan-slice",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "active" }),
    recordResult: () => insertReplanHistory({ milestoneId: MID, sliceId: SID, summary: "Replanned after a blocker." }),
    writeProjections: () => writeFile(join(sliceDir(), `${SID}-REPLAN.md`), ["# Replan", "", "Replanned after a blocker."]),
  },
  {
    unitType: "run-uat",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" }),
    recordResult: () => insertAssessment({
      path: `milestones/${MID}/slices/${SID}/${SID}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SID,
      status: "pass",
      scope: "run-uat",
      fullContent: "---\nverdict: pass\n---\n",
    }),
    writeProjections: () => writeFile(join(sliceDir(), `${SID}-ASSESSMENT.md`), ["---", "verdict: PASS", "---", "", "# UAT Assessment"]),
  },
  {
    unitType: "complete-slice",
    unitId: `${MID}/${SID}`,
    setup: () => insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "active" }),
    recordResult: () => updateSliceStatus(MID, SID, "complete", new Date().toISOString()),
    writeProjections: () => {
      writeFile(join(sliceDir(), `${SID}-SUMMARY.md`), ["# Slice summary", "", "Done."]);
      writeFile(join(sliceDir(), `${SID}-UAT.md`), ["# UAT", "", "Checks."]);
    },
  },
  {
    unitType: "reactive-execute",
    unitId: `${MID}/${SID}/reactive+T01,T02`,
    setup: () => {
      insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "active" });
      insertTask({ id: "T01", sliceId: SID, milestoneId: MID, title: "First task", status: "pending" });
      insertTask({ id: "T02", sliceId: SID, milestoneId: MID, title: "Second task", status: "pending" });
    },
    recordResult: () => {
      updateTaskStatus(MID, SID, "T01", "complete", new Date().toISOString());
      updateTaskStatus(MID, SID, "T02", "complete", new Date().toISOString());
    },
    writeProjections: () => {
      writeFile(join(sliceDir(), "tasks", "T01-SUMMARY.md"), ["---", "id: T01", "---", "# T01: Done"]);
      writeFile(join(sliceDir(), "tasks", "T02-SUMMARY.md"), ["---", "id: T02", "---", "# T02: Done"]);
    },
  },
];

describe("verifyExpectedArtifact reads DB rows only", () => {
  for (const unit of UNIT_CASES) {
    test(`${unit.unitType}: a recorded result verifies with every projection file absent`, () => {
      unit.setup?.();
      unit.recordResult();

      assert.equal(verifyExpectedArtifact(unit.unitType, unit.unitId, base), true);
    });

    test(`${unit.unitType}: well-formed projection files with no recorded result do not verify`, () => {
      unit.setup?.();
      unit.writeProjections();

      assert.equal(verifyExpectedArtifact(unit.unitType, unit.unitId, base), false);
    });
  }

  test("complete-milestone: a closed milestone verifies with no SUMMARY file", () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" });
    insertAssessment({
      path: `milestones/${MID}/${MID}-VALIDATION.md`,
      milestoneId: MID,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n",
    });
    updateMilestoneStatus(MID, "complete", new Date().toISOString());

    assert.equal(verifyExpectedArtifact("complete-milestone", MID, base), true);
  });

  test("complete-milestone: a SUMMARY file does not verify an open milestone", () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" });
    insertAssessment({
      path: `milestones/${MID}/${MID}-VALIDATION.md`,
      milestoneId: MID,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n",
    });
    writeFile(join(milestoneDir(), `${MID}-SUMMARY.md`), ["# Milestone summary", "", "All work verified and complete."]);

    assert.equal(verifyExpectedArtifact("complete-milestone", MID, base), false);
  });
});

describe("a unit that timed out is not complete", () => {
  test("research-slice: the recovery blocker is a sidecar and a DB row, and the unit stays incomplete", () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" });
    mkdirSync(sliceDir(), { recursive: true });
    const unitId = `${MID}/${SID}`;

    const written = writeBlockerPlaceholder("research-slice", unitId, base, "hard recovery exhausted 1 attempts");

    assert.ok(written, "a diagnostic sidecar must be written");
    const researchPath = resolveExpectedArtifactPath("research-slice", unitId, base);
    assert.ok(researchPath);
    assert.notEqual(join(base, written), researchPath, "the blocker must not take the RESEARCH projection path");
    assert.match(written, /RECOVERY-BLOCKER\.md$/);
    assert.equal(hasUnitRecoveryBlock("research-slice", unitId), true, "the outcome is recorded in the DB");
    assert.equal(
      verifyExpectedArtifact("research-slice", unitId, base),
      false,
      "a timed-out research unit must not verify as complete",
    );
  });

  test("research-slice: dispatch selects the unit again after the blocker", async () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" });
    mkdirSync(sliceDir(), { recursive: true });
    writeBlockerPlaceholder("research-slice", `${MID}/${SID}`, base, "hard recovery exhausted 1 attempts");

    const action = await matchRule("planning (no research) → research-slice", planningState());

    assert.equal(action?.action, "dispatch");
    assert.equal(action?.action === "dispatch" ? action.unitType : null, "research-slice");
  });
});

describe("a heading in a projection file closes no quality gate", () => {
  function seedPendingGate(): void {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" });
    insertGateRow({ milestoneId: MID, sliceId: SID, gateId: "Q3", scope: "slice" });
  }

  test("a Threat Surface heading in PLAN.md leaves Q3 pending", () => {
    seedPendingGate();
    writeFile(join(sliceDir(), `${SID}-PLAN.md`), [`# ${SID}: Slice`, "", "## Threat Surface", "", "- Reviewed, none."]);

    const result = closeQualityGatesFromEvidence(MID, { storedSectionEvidence: true });

    assert.deepEqual(result.repaired, []);
    assert.deepEqual(getPendingGates(MID, SID).map((gate) => gate.gate_id), ["Q3"]);
  });

  test("the same section in the saved PLAN artifact row closes Q3", () => {
    seedPendingGate();
    insertArtifact({
      path: `milestones/${MID}/slices/${SID}/${SID}-PLAN.md`,
      artifact_type: "PLAN",
      milestone_id: MID,
      slice_id: SID,
      task_id: null,
      full_content: [`# ${SID}: Slice`, "", "## Threat Surface", "", "- Reviewed, none."].join("\n"),
    });

    const result = closeQualityGatesFromEvidence(MID, { storedSectionEvidence: true });

    assert.deepEqual(result.repaired.map((repair) => repair.gateId), ["Q3"]);
    assert.deepEqual(getPendingGates(MID, SID), []);
  });
});

// ─── Dispatch rules ──────────────────────────────────────────────────────────

function planningState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: MID, title: "Evidence" },
    activeSlice: { id: SID, title: "Slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function dispatchContext(state: GSDState, prefs?: GSDPreferences): DispatchContext {
  return { basePath: base, mid: MID, midTitle: "Evidence", state, prefs };
}

async function matchRule(name: string, state: GSDState, prefs?: GSDPreferences): Promise<DispatchAction | null> {
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === name);
  assert.ok(rule, `dispatch rule "${name}" must exist`);
  return rule.match(dispatchContext(state, prefs));
}

function dispatchedUnit(action: DispatchAction | null): string | null {
  return action?.action === "dispatch" ? action.unitType : null;
}

describe("dispatch rules read DB rows only", () => {
  const prePlanning = () => planningState({ phase: "pre-planning", activeSlice: null });

  test("discuss-milestone: a saved CONTEXT row advances with no CONTEXT file", async () => {
    saveArtifact("CONTEXT", null);

    assert.equal(await matchRule("pre-planning (no context) → discuss-milestone", prePlanning()), null);
  });

  test("discuss-milestone: a CONTEXT file with no saved row does not advance", async () => {
    writeFile(join(milestoneDir(), `${MID}-CONTEXT.md`), ["# Context", "", "Decisions."]);

    const action = await matchRule("pre-planning (no context) → discuss-milestone", prePlanning());

    assert.equal(dispatchedUnit(action), "discuss-milestone");
  });

  test("research-milestone: a saved RESEARCH row advances with no RESEARCH file", async () => {
    saveArtifact("RESEARCH", null);

    assert.equal(await matchRule("pre-planning (no research) → research-milestone", prePlanning()), null);
  });

  test("research-milestone: a RESEARCH file with no saved row does not advance", async () => {
    writeFile(join(milestoneDir(), `${MID}-RESEARCH.md`), ["# Research", "", "Findings."]);

    const action = await matchRule("pre-planning (no research) → research-milestone", prePlanning());

    assert.equal(dispatchedUnit(action), "research-milestone");
  });

  test("research-slice: a saved RESEARCH row advances with no RESEARCH file", async () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" });
    saveArtifact("RESEARCH", SID);

    assert.equal(await matchRule("planning (no research) → research-slice", planningState()), null);
  });

  test("research-slice: a RESEARCH file with no saved row does not advance", async () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" });
    writeFile(join(sliceDir(), `${SID}-RESEARCH.md`), ["# Slice research", "", "Findings."]);

    const action = await matchRule("planning (no research) → research-slice", planningState());

    assert.equal(dispatchedUnit(action), "research-slice");
  });

  test("slice discussion: a saved CONTEXT row lets planning proceed with no CONTEXT file", async () => {
    const prefs = { phases: { require_slice_discussion: true } } as unknown as GSDPreferences;
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" });
    saveArtifact("CONTEXT", SID);

    assert.equal(
      await matchRule("planning (require_slice_discussion) → pause for discussion", planningState(), prefs),
      null,
    );
  });

  test("slice discussion: a CONTEXT file with no saved row still pauses for discussion", async () => {
    const prefs = { phases: { require_slice_discussion: true } } as unknown as GSDPreferences;
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "pending" });
    writeFile(join(sliceDir(), `${SID}-CONTEXT.md`), ["# Slice context", "", "Decisions."]);

    const action = await matchRule("planning (require_slice_discussion) → pause for discussion", planningState(), prefs);

    assert.equal(action?.action, "stop");
  });

  test("parallel research: a dependency is done by its DB status, not by a SUMMARY file", async () => {
    insertSlice({ id: "S01", milestoneId: MID, title: "Base", status: "complete", sequence: 1 });
    insertSlice({ id: "S02", milestoneId: MID, title: "Second", status: "pending", depends: ["S01"], sequence: 2 });
    insertSlice({ id: "S03", milestoneId: MID, title: "Third", status: "pending", depends: ["S01"], sequence: 3 });

    const action = await matchRule(
      "planning (multiple slices need research) → parallel-research-slices",
      planningState({ activeSlice: { id: "S02", title: "Second" } }),
    );

    assert.equal(action?.action === "dispatch" ? action.unitId : null, `${MID}/parallel-research`);
  });

  test("parallel research: a SUMMARY file does not make an open dependency done", async () => {
    insertSlice({ id: "S01", milestoneId: MID, title: "Base", status: "active", sequence: 1 });
    insertSlice({ id: "S02", milestoneId: MID, title: "Second", status: "pending", depends: ["S01"], sequence: 2 });
    insertSlice({ id: "S03", milestoneId: MID, title: "Third", status: "pending", depends: ["S01"], sequence: 3 });
    writeFile(join(milestoneDir(), "slices", "S01", "S01-SUMMARY.md"), ["# Slice summary", "", "Done."]);

    const action = await matchRule(
      "planning (multiple slices need research) → parallel-research-slices",
      planningState({ activeSlice: { id: "S01", title: "Base" } }),
    );

    assert.equal(action, null, "S02 and S03 depend on an open slice and are not research-ready");
  });
});

describe("milestone validation and closeout read slice status from the DB", () => {
  const validating = () => planningState({ phase: "validating-milestone", activeSlice: null });

  test("validate-milestone is dispatched for closed slices with no SUMMARY file", async () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" });

    const action = await matchRule("validating-milestone → validate-milestone", validating());

    assert.equal(dispatchedUnit(action), "validate-milestone");
  });

  test("a SUMMARY file does not let an open slice into milestone validation", async () => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "active" });
    writeFile(join(sliceDir(), `${SID}-SUMMARY.md`), ["# Slice summary", "", "Done."]);

    const action = await matchRule("validating-milestone → validate-milestone", validating());

    assert.equal(action?.action, "stop");
    assert.match(action?.action === "stop" ? action.reason : "", new RegExp(`${SID} are not closed`));
  });
});

describe("UAT dispatch and sign-off read the run-uat row", () => {
  const UAT_SPEC = ["# UAT", "", "## UAT Type", "", "- UAT mode: artifact-driven", "", "## Checks", "", "- Review the output."].join("\n");
  const uatPrefs = { uat_dispatch: true } as unknown as GSDPreferences;
  const closeout = () => planningState({ phase: "completing-milestone", activeSlice: null });

  beforeEach(() => {
    insertSlice({ id: SID, milestoneId: MID, title: "Slice", status: "complete" });
    setSliceUatMd(MID, SID, UAT_SPEC);
  });

  test("run-uat is dispatched from the stored UAT spec with no UAT file on disk", async () => {
    const action = await matchRule("run-uat (post-completion)", closeout(), uatPrefs);

    assert.equal(dispatchedUnit(action), "run-uat");
  });

  test("a PASS verdict edited into ASSESSMENT.md does not stop run-uat dispatch", async () => {
    writeFile(join(sliceDir(), `${SID}-ASSESSMENT.md`), ["---", "verdict: PASS", "---", "", "# UAT Assessment"]);

    const action = await matchRule("run-uat (post-completion)", closeout(), uatPrefs);

    assert.equal(dispatchedUnit(action), "run-uat");
  });

  test("a recorded PASS row stops run-uat dispatch with no ASSESSMENT file", async () => {
    insertAssessment({
      path: `milestones/${MID}/slices/${SID}/${SID}-ASSESSMENT.md`,
      milestoneId: MID,
      sliceId: SID,
      status: "pass",
      scope: "run-uat",
      fullContent: "---\nverdict: pass\n---\n",
    });

    assert.equal(await matchRule("run-uat (post-completion)", closeout(), uatPrefs), null);
  });

  test("a PASS verdict edited into ASSESSMENT.md does not sign off milestone closeout", async () => {
    writeFile(join(sliceDir(), `${SID}-ASSESSMENT.md`), ["---", "verdict: PASS", "---", "", "# UAT Assessment"]);

    const action = await evaluateGuardedCompleteMilestoneDispatch({
      ...dispatchContext(closeout(), uatPrefs),
      preview: true,
    });

    assert.equal(action.action, "stop");
    assert.match(action.action === "stop" ? action.reason : "", new RegExp(SID));
  });
});
