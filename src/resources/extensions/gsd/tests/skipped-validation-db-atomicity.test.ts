import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES } from "../auto-dispatch.ts";
import {
  closeDatabase,
  getArtifact,
  getAssessment,
  getLatestAssessmentByScope,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";

test("skipped validation dispatch persists the validation file and DB assessment together", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-skip-validation-"));
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const rule = DISPATCH_RULES.find((r) => r.name === "validating-milestone → validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");

  try {
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n", "utf-8");
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Done slice",
      status: "complete",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1,
    });

    const action = await rule.match({
      state: { phase: "validating-milestone" },
      mid: "M001",
      midTitle: "Validation",
      basePath,
      prefs: { phases: { skip_milestone_validation: true } },
    } as any);

    assert.deepEqual(action, { action: "skip" });
    assert.equal(existsSync(join(milestoneDir, "M001-VALIDATION.md")), true);
    assert.equal(
      getLatestAssessmentByScope("M001", "milestone-validation")?.status,
      "pass",
    );
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("P16: validation dispatch never turns an ASSESSMENT file into a UAT sign-off row", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-assessment-file-"));
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  const slicesDir = join(basePath, ".gsd", "milestones", "M001", "slices");
  const rule = DISPATCH_RULES.find((r) => r.name === "validating-milestone → validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");

  for (const id of ["S01", "S02"]) {
    mkdirSync(join(slicesDir, id), { recursive: true });
    writeFileSync(join(slicesDir, id, `${id}-SUMMARY.md`), `# ${id} Summary\n`, "utf-8");
  }
  // S01: an ASSESSMENT that no gsd_uat_result_save call produced. S02: none.
  writeFileSync(join(slicesDir, "S01", "S01-ASSESSMENT.md"), "---\nverdict: PASS\n---\n\n# Assessment\n", "utf-8");
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
  for (const [index, id] of ["S01", "S02"].entries()) {
    insertSlice({ id, milestoneId: "M001", title: id, status: "complete", risk: "low", depends: [], demo: "", sequence: index + 1 });
  }

  await rule.match({
    state: { phase: "validating-milestone" },
    mid: "M001",
    midTitle: "Validation",
    basePath,
    prefs: { phases: { skip_milestone_validation: true } },
  } as any);

  for (const id of ["S01", "S02"]) {
    const artifactPath = `milestones/M001/slices/${id}/${id}-ASSESSMENT.md`;
    assert.equal(getArtifact(artifactPath), null, `${id}: no ASSESSMENT artifact row`);
    assert.equal(getAssessment(`.gsd/${artifactPath}`), null, `${id}: no assessment row`);
  }
  assert.equal(
    existsSync(join(slicesDir, "S02", "S02-ASSESSMENT.md")),
    false,
    "no placeholder ASSESSMENT file is fabricated",
  );
});
