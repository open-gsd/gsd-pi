// Project/App: gsd-pi
// File Purpose: Host-executed commands are exec_runs rows, and UAT evidence is
// judged from those rows, not from `.gsd/exec` or `.gsd/uat` files (ADR-046).

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, insertGateRun, openDatabase } from "../gsd-db.ts";
import { runExecSandbox } from "../exec-sandbox.ts";
import { readExecRun } from "../db/writers/exec-runs.ts";
import { executeGsdExec, executeUatExec } from "../tools/exec-tool.ts";
import { buildRunUatPresentationForType } from "../tool-presentation-plan.ts";
import { prepareUatRun, type UatEvidenceRef, type UatResultSaveParams } from "../uat-run.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gsd-exec-run-evidence-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
});

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

/** Run a real command through the tool and return the id of the run. */
async function uatExec(sliceId: string, script: string): Promise<string> {
  const result = await executeUatExec(
    { milestoneId: "M001", sliceId, checkId: "UAT-01", intent: "uat-runtime-check", script },
    { baseDir: base, preferences: null },
  );
  return String(result.details?.id);
}

function uatResult(sliceId: string, evidence: UatEvidenceRef[]): UatResultSaveParams {
  return {
    milestoneId: "M001",
    sliceId,
    uatType: "runtime-executable",
    verdict: "PASS",
    checks: [{
      id: "UAT-01",
      description: "The service answers",
      mode: "runtime",
      result: "PASS",
      evidence,
      notes: "Checked through the host.",
    }],
    presentation: buildRunUatPresentationForType("runtime-executable"),
  };
}

/** What gsd_uat_result_save stores for an attempt: the row the attempt number comes from. */
function saveUatAttempt(sliceId: string, attempt: number): void {
  insertGateRun({
    traceId: `uat:M001:${sliceId}`,
    turnId: `uat:M001:${sliceId}:attempt-${attempt}`,
    gateId: "UAT",
    gateType: "uat",
    unitType: "run-uat",
    unitId: `run-uat:M001/${sliceId}`,
    milestoneId: "M001",
    sliceId,
    outcome: "fail",
    failureClass: "verification",
    attempt,
    maxAttempts: attempt,
    retryable: true,
    evaluatedAt: new Date().toISOString(),
  });
}

describe("host exec runs are database rows", () => {
  test("gsd_exec stores the run, and the row resolves after .gsd/exec is deleted", async () => {
    const result = await executeGsdExec({ script: "printf ok" }, { baseDir: base, preferences: null });
    const id = String(result.details?.id);
    assert.ok(existsSync(join(base, ".gsd", "exec", `${id}.meta.json`)));

    rmSync(join(base, ".gsd", "exec"), { recursive: true, force: true });

    const run = readExecRun(id);
    assert.equal(run?.kind, "exec");
    assert.equal(run?.command, "printf ok");
    assert.equal(run?.exit_code, 0);
    assert.match(run?.output_hash ?? "", /^sha256:[0-9a-f]{64}$/);
    // No Task Attempt is running, so the run is bound to none and backs no claim.
    assert.equal(run?.attempt_ref, null);
  });

  test("a run the host cannot record still returns its exit code and output, with a warning", async () => {
    // The output file is gone before the host hashes it, so the record step fails.
    const result = await executeGsdExec({ script: "printf done; exit 3" }, {
      baseDir: base,
      preferences: null,
      run: async (request, options) => {
        const ran = await runExecSandbox(request, options);
        rmSync(ran.stdout_path);
        return ran;
      },
    });

    const text = result.content[0]!.text;
    assert.equal(result.details?.exit_code, 3);
    assert.match(text, /exit=3/);
    assert.match(text, /done/);
    assert.match(text, /did not record this run: ENOENT/);
    assert.match(String(result.details?.run_not_recorded), /ENOENT/);
    assert.equal(readExecRun(String(result.details?.id)), null);
  });

  test("gsd_uat_exec stores the slice and the run-uat attempt of the run", async () => {
    const first = readExecRun(await uatExec("S01", "printf ok"));
    assert.equal(first?.kind, "uat_exec");
    assert.equal(first?.milestone_id, "M001");
    assert.equal(first?.slice_id, "S01");
    assert.equal(first?.check_id, "UAT-01");
    assert.equal(first?.attempt_ref, "uat:M001:S01:attempt-1");

    saveUatAttempt("S01", 1);

    assert.equal(readExecRun(await uatExec("S01", "printf ok"))?.attempt_ref, "uat:M001:S01:attempt-2");
  });
});

describe("UAT evidence is judged from exec_runs rows", () => {
  test("a PASS is accepted after .gsd/exec and .gsd/uat are deleted", async () => {
    const id = await uatExec("S01", "printf ok");
    rmSync(join(base, ".gsd", "exec"), { recursive: true, force: true });
    rmSync(join(base, ".gsd", "uat"), { recursive: true, force: true });

    const result = prepareUatRun(base, uatResult("S01", [{ kind: "gsd_uat_exec", ref: id }]));

    if (!result.ok) assert.fail(result.error.message);
    assert.equal(result.run.runId, "uat:M001:S01:attempt-1");
  });

  test("an exec id of another slice is rejected for a UAT PASS", async () => {
    const otherSliceRun = await uatExec("S02", "printf ok");

    const result = prepareUatRun(base, uatResult("S01", [{ kind: "gsd_uat_exec", ref: otherSliceRun }]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_evidence");
    assert.match(result.error.message, /recorded for M001\/S02, not for M001\/S01/);
  });

  test("an exec id of an earlier run-uat attempt is rejected for a UAT PASS", async () => {
    const firstAttemptRun = await uatExec("S01", "printf ok");
    saveUatAttempt("S01", 1);

    const result = prepareUatRun(base, uatResult("S01", [{ kind: "gsd_uat_exec", ref: firstAttemptRun }]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_evidence");
    assert.match(result.error.message, /recorded in uat:M001:S01:attempt-1, not in this run \(uat:M001:S01:attempt-2\)/);
  });

  test("a save cannot name an earlier attempt to make its old evidence count", async () => {
    const firstAttemptRun = await uatExec("S01", "printf ok");
    saveUatAttempt("S01", 1);

    const result = prepareUatRun(base, {
      ...uatResult("S01", [{ kind: "gsd_uat_exec", ref: firstAttemptRun }]),
      attempt: "1",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_attempt");
    assert.match(result.error.message, /attempt must be auto or 2/);
  });

  test("a save that names the next attempt gets the same run as auto", async () => {
    saveUatAttempt("S01", 1);
    const fresh = await uatExec("S01", "printf ok");

    const result = prepareUatRun(base, { ...uatResult("S01", [{ kind: "gsd_uat_exec", ref: fresh }]), attempt: "2" });

    if (!result.ok) assert.fail(result.error.message);
    assert.equal(result.run.runId, "uat:M001:S01:attempt-2");
  });

  test("a gsd_uat_exec run of another slice is rejected when it is cited as gsd_exec", async () => {
    const fresh = await uatExec("S01", "printf ok");
    const otherSliceRun = await uatExec("S02", "printf ok");

    const result = prepareUatRun(base, uatResult("S01", [
      { kind: "gsd_uat_exec", ref: fresh },
      { kind: "gsd_exec", ref: otherSliceRun },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_evidence");
    assert.match(result.error.message, /recorded for M001\/S02, not for M001\/S01/);
  });

  test("a gsd_uat_exec run of an earlier attempt is rejected when it is cited as gsd_exec", async () => {
    const firstAttemptRun = await uatExec("S01", "printf ok");
    saveUatAttempt("S01", 1);
    const fresh = await uatExec("S01", "printf ok");

    const result = prepareUatRun(base, uatResult("S01", [
      { kind: "gsd_uat_exec", ref: fresh },
      { kind: "gsd_exec", ref: firstAttemptRun },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_evidence");
    assert.match(result.error.message, /recorded in uat:M001:S01:attempt-1, not in this run \(uat:M001:S01:attempt-2\)/);
  });

  test("an exec id the host never recorded is rejected, even with a meta.json file on disk", async () => {
    const id = await uatExec("S01", "printf ok");
    closeDatabase();
    rmSync(join(base, ".gsd", "gsd.db"), { force: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    assert.ok(existsSync(join(base, ".gsd", "exec", `${id}.meta.json`)));

    const result = prepareUatRun(base, uatResult("S01", [{ kind: "gsd_uat_exec", ref: id }]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /names no host-recorded run/);
  });

  test("a run is cited by its id or by its .meta.json path under .gsd/exec, and by no other path", async () => {
    const id = await uatExec("S01", "printf ok");
    const cite = (ref: string) => prepareUatRun(base, uatResult("S01", [{ kind: "gsd_uat_exec", ref }]));

    assert.equal(cite(id).ok, true);
    assert.equal(cite(`.gsd/exec/${id}.meta.json`).ok, true);
    assert.equal(cite(join(realpathSync(base), ".gsd", "exec", `${id}.meta.json`)).ok, true);

    for (const ref of [`.gsd/exec/${id}.stdout`, `.gsd/exec/${id}.stderr`, `other/${id}.meta.json`, join(base, `${id}.meta.json`)]) {
      const result = cite(ref);
      assert.equal(result.ok, false, ref);
      if (result.ok) continue;
      assert.match(result.error.message, /names no host-recorded run/, ref);
    }
  });

  test("a PASS that cites a failed gsd_exec run is rejected", async () => {
    const fresh = await uatExec("S01", "printf ok");
    const failed = await executeGsdExec({ script: "exit 3" }, { baseDir: base, preferences: null });

    const result = prepareUatRun(base, uatResult("S01", [
      { kind: "gsd_uat_exec", ref: fresh },
      { kind: "gsd_exec", ref: String(failed.details?.id) },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /PASS cites gsd_exec evidence id .* exit_code=3/);
  });

  test("a screenshot ref to a file that does not exist is rejected", async () => {
    const fresh = await uatExec("S01", "printf ok");

    const result = prepareUatRun(base, uatResult("S01", [
      { kind: "gsd_uat_exec", ref: fresh },
      { kind: "screenshot", ref: ".artifacts/browser/session/missing.png" },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /names a file that does not exist/);
  });
});
