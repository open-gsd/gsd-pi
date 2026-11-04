import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  prepareUatRun,
  type UatEvidenceRef,
  type UatResultSaveParams,
} from "../uat-run.ts";
import { buildRunUatPresentationForType } from "../tool-presentation-plan.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { recordExecRun } from "../db/writers/exec-runs.ts";
import { execRunOutputHash } from "../verification-gate.ts";

type EvidenceInput = UatEvidenceRef | { kind: string; ref: string };

/** A project root with an open workflow database: exec evidence is its exec_runs rows. */
function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-uat-run-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function cleanup(base: string): void {
  closeDatabase();
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

/** Record a gsd_uat_exec run of M001/S01 as the host does when the command ends. */
function writeUatExecEvidence(
  base: string,
  outcome: { exit_code: number | null; signal: string | null; timed_out: boolean; aborted: boolean },
  id = "fresh-uat-evidence",
): string {
  const execDir = join(base, ".gsd", "exec");
  mkdirSync(execDir, { recursive: true });
  const stdout = Buffer.from(`synthetic UAT output for ${id}\n`);
  const stderr = Buffer.alloc(0);
  const stdoutPath = join(execDir, `${id}.stdout`);
  const stderrPath = join(execDir, `${id}.stderr`);
  const metaPath = join(execDir, `${id}.meta.json`);
  const startedAt = new Date().toISOString();
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  writeFileSync(metaPath, JSON.stringify({
    id,
    runtime: "bash",
    started_at: startedAt,
    exit_code: outcome.exit_code,
    signal: outcome.signal,
    timed_out: outcome.timed_out,
    aborted: outcome.aborted,
    duration_ms: 1,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stdout_truncated: false,
    stderr_truncated: false,
  }));
  recordExecRun({
    kind: "uat_exec",
    milestoneId: "M001",
    sliceId: "S01",
    checkId: "UAT-01",
    id,
    runtime: "bash",
    command: "node check.js",
    cwd: base,
    exit_code: outcome.exit_code,
    signal: outcome.signal,
    timedOut: outcome.timed_out,
    aborted: outcome.aborted,
    started_at: startedAt,
    duration_ms: 1,
    output_hash: `sha256:${createHash("sha256").update(stdout).update(stderr).digest("hex")}`,
  });
  return id;
}

function writeFreshUatEvidence(base: string, id = "fresh-uat-evidence"): string {
  return writeUatExecEvidence(base, { exit_code: 0, signal: null, timed_out: false, aborted: false }, id);
}

function writeContractExecEvidence(base: string, id: string, stdoutText: string): string {
  const execDir = join(base, ".gsd", "exec");
  mkdirSync(execDir, { recursive: true });
  const stdout = Buffer.from(stdoutText);
  const stderr = Buffer.alloc(0);
  const stdoutPath = join(execDir, `${id}.stdout`);
  const stderrPath = join(execDir, `${id}.stderr`);
  const startedAt = new Date().toISOString();
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  writeFileSync(join(execDir, `${id}.meta.json`), JSON.stringify({
    id,
    runtime: "bash",
    started_at: startedAt,
    exit_code: 0,
    signal: null,
    timed_out: false,
    aborted: false,
    duration_ms: 1,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stdout_truncated: false,
    stderr_truncated: false,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  }));
  recordExecRun({
    kind: "exec",
    id,
    runtime: "bash",
    command: "verified check",
    cwd: base,
    exit_code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    started_at: startedAt,
    duration_ms: 1,
    output_hash: execRunOutputHash(stdout, stderr),
    runContract: "test-invocation-contract",
    sourceRevision: "sha256:test-source",
  });
  return id;
}

function buildParams(
  evidence: EvidenceInput[],
  options: {
    uatType?: UatResultSaveParams["uatType"];
    mode?: UatResultSaveParams["checks"][number]["mode"];
    verdict?: UatResultSaveParams["verdict"];
    checkResult?: UatResultSaveParams["checks"][number]["result"];
  } = {},
): UatResultSaveParams {
  const uatType = options.uatType ?? "runtime-executable";
  const verdict = options.verdict ?? "PASS";
  return {
    milestoneId: "M001",
    sliceId: "S01",
    uatType,
    verdict,
    checks: [{
      id: "UAT-01",
      description: "Evidence contract check",
      mode: options.mode ?? "runtime",
      result: options.checkResult ?? "PASS",
      evidence: evidence as UatEvidenceRef[],
      notes: "Evidence validation should be explicit.",
    }],
    presentation: buildRunUatPresentationForType(uatType),
    notes: `UAT ${verdict}.`,
  };
}

test("prepareUatRun rejects successful exec rows whose output artifact is missing", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    rmSync(join(base, ".gsd", "exec", `${evidenceId}.stdout`));
    const result = prepareUatRun(base, buildParams([{ kind: "gsd_uat_exec", ref: evidenceId }]));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_evidence");
      assert.match(result.error.message, /persisted output artifacts/);
    }
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun validates contract-bearing exec hashes and rejects modified output", () => {
  const base = makeTmpBase();
  try {
    const uatEvidenceId = writeFreshUatEvidence(base);
    const execEvidenceId = writeContractExecEvidence(base, "contract-exec-evidence", "verified output\\n");
    const evidence = [
      { kind: "gsd_uat_exec", ref: uatEvidenceId },
      { kind: "gsd_exec", ref: execEvidenceId },
    ];
    const valid = prepareUatRun(base, buildParams(evidence));
    assert.equal(valid.ok, true, valid.ok ? undefined : valid.error.message);

    writeFileSync(join(base, ".gsd", "exec", `${execEvidenceId}.stdout`), "modified output\\n");
    const modified = prepareUatRun(base, buildParams(evidence));
    assert.equal(modified.ok, false);
    if (!modified.ok) {
      assert.equal(modified.error.code, "invalid_evidence");
      assert.match(modified.error.message, /outputs do not match the host-recorded digest/);
    }
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects mismatched and ID-only exec metadata", () => {
  const base = makeTmpBase();
  try {
    const uatEvidenceId = writeFreshUatEvidence(base);
    const execEvidenceId = writeContractExecEvidence(base, "contract-metadata-evidence", "verified output\\n");
    const evidence = [
      { kind: "gsd_uat_exec", ref: uatEvidenceId },
      { kind: "gsd_exec", ref: execEvidenceId },
    ];
    const execDir = join(base, ".gsd", "exec");
    const metaPath = join(execDir, `${execEvidenceId}.meta.json`);
    const stdoutPath = join(execDir, `${execEvidenceId}.stdout`);
    const stderrPath = join(execDir, `${execEvidenceId}.stderr`);

    const metadata = {
      id: execEvidenceId,
      runtime: "bash",
      started_at: new Date().toISOString(),
      exit_code: 7,
      signal: null,
      timed_out: false,
      aborted: false,
      duration_ms: 1,
      stdout_bytes: Buffer.byteLength("verified output\\n"),
      stderr_bytes: 0,
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    };
    writeFileSync(metaPath, JSON.stringify(metadata));
    const mismatch = prepareUatRun(base, buildParams(evidence));
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.error.message, /outcome metadata does not match/);

    metadata.exit_code = 0;
    metadata.duration_ms = 99;
    writeFileSync(metaPath, JSON.stringify(metadata));
    const durationMismatch = prepareUatRun(base, buildParams(evidence));
    assert.equal(durationMismatch.ok, false);
    if (!durationMismatch.ok) assert.match(durationMismatch.error.message, /outcome metadata does not match/);

    writeFileSync(metaPath, JSON.stringify({ id: execEvidenceId }));
    const idOnly = prepareUatRun(base, buildParams(evidence));
    assert.equal(idOnly.ok, false);
    if (!idOnly.ok) assert.match(idOnly.error.message, /metadata identity/);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun accepts browser evidence backed by an http URL", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "browser", ref: "https://example.test/uat/session" },
    ], { uatType: "browser-executable", mode: "browser" }));

    if (!result.ok) assert.fail(result.error.message);
    assert.equal(result.run.params.checks[0]?.evidence?.[1]?.kind, "browser");
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun accepts screenshot and log evidence under approved roots", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    mkdirSync(join(base, ".artifacts", "browser", "session"), { recursive: true });
    mkdirSync(join(base, ".gsd", "uat", "M001", "S01"), { recursive: true });
    writeFileSync(join(base, ".artifacts", "browser", "session", "home.png"), "png", "utf-8");
    writeFileSync(join(base, ".gsd", "uat", "M001", "S01", "console.log"), "ok", "utf-8");

    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "screenshot", ref: ".artifacts/browser/session/home.png" },
      { kind: "log", ref: ".gsd/uat/M001/S01/console.log" },
    ], { uatType: "artifact-driven", mode: "artifact" }));

    if (!result.ok) assert.fail(result.error.message);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects unknown evidence kinds with the accepted kind list", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "artifact", ref: ".gsd/uat/M001/S01/readme.md" },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected invalid evidence");
    assert.match(result.error.message, /evidence\.kind must be one of: "gsd_uat_exec", "gsd_exec", "screenshot", "log", "url", "browser"/);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects log refs outside approved roots with recovery details", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "log", ref: "AGENTS.md#Security.External-access" },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected invalid evidence");
    assert.match(result.error.message, /log evidence ref must be a path under approved evidence locations/);
    assert.match(result.error.message, /\.gsd\/exec\//);
    assert.match(result.error.message, /\.gsd\/uat\//);
    assert.match(result.error.message, /\.artifacts\/browser\//);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects browser filesystem refs outside browser artifacts", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "browser", ref: ".gsd/uat/M001/S01/browser.json" },
    ], { uatType: "browser-executable", mode: "browser" }));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected invalid evidence");
    assert.match(result.error.message, /browser evidence ref must be an http:\/\/ or https:\/\/ URL/);
    assert.match(result.error.message, /\.artifacts\/browser\//);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence recorded a failed execution", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 1, signal: null, timed_out: false, aborted: false },
    "failed-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected failed-execution evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /failed-uat-evidence/);
  assert.match(result.error.message, /exit_code=1/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence recorded a non-null signal", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0, signal: "SIGTERM", timed_out: false, aborted: false },
    "signalled-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected signalled evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /signalled-uat-evidence/);
  assert.match(result.error.message, /signal=SIGTERM/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence timed out", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0, signal: null, timed_out: true, aborted: false },
    "timed-out-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected timed-out evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /timed-out-uat-evidence/);
  assert.match(result.error.message, /timed_out=true/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence was aborted", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0, signal: null, timed_out: false, aborted: true },
    "aborted-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected aborted evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /aborted-uat-evidence/);
  assert.match(result.error.message, /aborted=true/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence has no exit code", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: null, signal: null, timed_out: false, aborted: false },
    "exit-code-less-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected outcome-less evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /exit_code=null/);
});

test("prepareUatRun accepts a PASS check whose gsd_uat_exec evidence recorded a successful execution", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeFreshUatEvidence(base);
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  if (!result.ok) assert.fail(result.error.message);
  assert.equal(result.run.params.verdict, "PASS");
});

test("prepareUatRun still accepts a FAIL check whose gsd_uat_exec evidence recorded a failed execution", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 1, signal: null, timed_out: false, aborted: false },
    "failed-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ], { verdict: "FAIL", checkResult: "FAIL" }));

  if (!result.ok) assert.fail(result.error.message);
  assert.equal(result.run.params.verdict, "FAIL");
  assert.equal(result.run.gateOutcome, "fail");
});

test("prepareUatRun rejects on the PASS check alone when a FAIL check cites the same failing evidence", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 1, signal: null, timed_out: false, aborted: false },
    "failed-uat-evidence",
  );
  const params = buildParams(
    [{ kind: "gsd_uat_exec", ref: evidenceId }],
    { verdict: "FAIL", checkResult: "FAIL" },
  );
  params.checks.push({
    id: "UAT-02",
    description: "Second check wrongly claims success",
    mode: "runtime",
    result: "PASS",
    evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
    notes: "Claims the failing run passed.",
  });

  const result = prepareUatRun(base, params);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the PASS check to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-02/);
  assert.doesNotMatch(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /failed-uat-evidence/);
  assert.match(result.error.message, /exit_code=1/);
});
