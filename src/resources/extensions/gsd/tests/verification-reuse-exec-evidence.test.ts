// Project/App: gsd-pi
// File Purpose: Opt-in reuse of the executor's gsd_exec run in host
// verification (#2982). The gate reuses a recorded run only when it provably
// ran exactly as the gate runs it — same shell form, environment, rewrites,
// source revision and timeout; any divergence re-runs.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, getDb, openDatabase, _getAdapter } from "../gsd-db.ts";
import { recordExecRun, readExecRun } from "../db/writers/exec-runs.ts";
import { runVerificationGate, verificationCommandInvocation, execRunContractStorage, execRunOutputHash } from "../verification-gate.ts";
import type { ExecRunRow } from "../db/writers/exec-runs.ts";
import { executeGsdExec } from "../tools/exec-tool.ts";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.ts";

let base: string;
const markers: string[] = [];
// The contract and reuse paths are POSIX-only by design: Windows shell forms
// have no contract and never reuse.
const describePosix = process.platform === "win32" ? describe.skip : describe;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gsd-verification-reuse-"));
});

afterEach(() => {
  for (const key of markers.splice(0)) delete process.env[key];
  try {
    closeDatabase();
  } catch {
    // No database was opened for this test.
  }
  rmSync(base, { recursive: true, force: true });
});

/** A command that appends to counter.txt on every execution. */
function writeCounterScript(): void {
  writeFileSync(join(base, "count.sh"), "echo x >> counter.txt\n");
  chmodSync(join(base, "count.sh"), 0o755);
}

function counterCount(): number {
  const path = join(base, "counter.txt");
  return existsSync(path) ? readFileSync(path, "utf-8").split("x").length - 1 : 0;
}

function execRunRow(overrides: Partial<ExecRunRow> & Pick<ExecRunRow, "id" | "run_contract">): ExecRunRow {
  return {
    kind: "exec",
    runtime: "bash",
    command: "./count.sh",
    cwd: base,
    exit_code: 0,
    signal: null,
    timed_out: 0,
    aborted: 0,
    started_at: "2026-10-22T10:00:00.000Z",
    duration_ms: 1_000,
    output_hash: `sha256:${"0".repeat(64)}`,
    milestone_id: null,
    slice_id: null,
    check_id: null,
    attempt_ref: "attempt-1",
    source_revision: null,
    ...overrides,
  };
}

/**
 * Persist a run's output files the way the exec sandbox does and return the
 * contract row's per-stream hash (#2982).
 */
function writeRunOutput(id: string, stdout: string, stderr: string): string {
  const dir = join(base, ".gsd", "exec");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.stdout`), stdout);
  writeFileSync(join(dir, `${id}.stderr`), stderr);
  return execRunOutputHash(Buffer.from(stdout, "utf-8"), Buffer.from(stderr, "utf-8"));
}

/**
 * The run row the gate must reuse: recorded under the gate's own invocation,
 * with persisted output whose hash matches the row.
 */
function matchingRun(id: string, sourceRevision: string | null, extra: Partial<ExecRunRow> = {}, output?: { stdout: string; stderr: string }): ExecRunRow {
  const invocation = verificationCommandInvocation("./count.sh", base);
  assert.ok(invocation);
  return execRunRow({
    id,
    run_contract: execRunContractStorage(invocation),
    source_revision: sourceRevision,
    output_hash: writeRunOutput(id, output?.stdout ?? "", output?.stderr ?? ""),
    ...extra,
  });
}

describePosix("gate reuse of recorded exec runs (#2982)", () => {
  test("a provably matching run stands in for the gate and the command does not run again", async () => {
    writeCounterScript();
    const run = matchingRun("run-1", "sha256:rev-a");
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      commandTimeoutMs: 60_000,
      reuseExecRuns: {
        runs: [run],
        sourceRevision: "sha256:rev-a",
      },
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0]!.command, "./count.sh");
    assert.equal(result.checks[0]!.exitCode, 0);
    assert.deepEqual(result.checks[0]!.reusedRun, {
      runId: "run-1",
      startedAt: "2026-10-22T10:00:00.000Z",
      durationMs: 1_000,
      outputHash: run.output_hash,
    });
    assert.equal(counterCount(), 0, "the gate must not execute a command whose recorded run it reused");
  });

  test("a run recorded as a plain bash -c form (no pipefail) re-runs", async () => {
    writeCounterScript();
    // The exec sandbox's own shell form: bash -c <script>, no pipefail wrapper.
    const mismatched = execRunRow({
      id: "run-bash-c",
      run_contract: JSON.stringify({
        program: "bash",
        args: ["-c", "./count.sh"],
        cwd: base,
        digest: "sha256:" + "1".repeat(64),
      }),
      source_revision: "sha256:rev-a",
    });
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [mismatched], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1, "a gate that cannot prove the run's shell form must run the command");
  });

  test("a run on a different source revision re-runs", async () => {
    writeCounterScript();
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [matchingRun("run-stale", "sha256:old")], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("a run that took at least the gate timeout re-runs", async () => {
    writeCounterScript();
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      commandTimeoutMs: 60_000,
      reuseExecRuns: {
        runs: [matchingRun("run-slow", "sha256:rev-a", { duration_ms: 60_000 })],
        sourceRevision: "sha256:rev-a",
      },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("a newer failed run of the same command re-runs", async () => {
    writeCounterScript();
    // The production writer records the contract but no revision for a
    // failed run, so the newest run of the command is the failed one.
    const olderPass = matchingRun("run-old-pass", "sha256:rev-a", { started_at: "2026-10-22T09:59:00.000Z" });
    const newerFailed = matchingRun("run-new-fail", null, {
      exit_code: 1,
      started_at: "2026-10-22T10:01:00.000Z",
    });
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [olderPass, newerFailed], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1, "the executor's latest observation is red; the gate must run");
  });

  test("two runs of one command sharing a timestamp are conflicting observations and re-run", async () => {
    writeCounterScript();
    const pass = matchingRun("run-pass", "sha256:rev-a", { started_at: "2026-10-22T10:00:00.000Z" });
    const fail = matchingRun("run-fail", "sha256:rev-a", {
      exit_code: 1,
      started_at: "2026-10-22T10:00:00.000Z",
    });
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [pass, fail], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1, "which run is newest is unknowable; the gate runs");
  });

  test("a run whose recorded output is gone re-runs", async () => {
    writeCounterScript();
    const run = matchingRun("run-no-output", "sha256:rev-a");
    rmSync(join(base, ".gsd", "exec"), { recursive: true, force: true });
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [run], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("a run whose recorded output no longer matches its hash re-runs", async () => {
    writeCounterScript();
    const run = matchingRun("run-tampered", "sha256:rev-a");
    writeFileSync(join(base, ".gsd", "exec", "run-tampered.stderr"), "rewritten after the fact\n");
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [run], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("a run whose persisted output was bounded at persist time re-runs", async () => {
    writeCounterScript();
    const run = matchingRun("run-bounded", "sha256:rev-a", {}, {
      stdout: "",
      stderr: "tail\n[truncated: verification output cap reached]\n",
    });
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [run], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("moving classification text between streams changes the hash and re-runs", async () => {
    writeCounterScript();
    // Recorded with the diagnostic on stderr; the persisted files now hold it
    // on stdout. The per-stream hashes catch what a concatenated hash would not.
    const run = matchingRun("run-moved", "sha256:rev-a", {}, {
      stdout: "",
      stderr: "sh: gsd_missing_verify_tool: command not found\n",
    });
    writeFileSync(join(base, ".gsd", "exec", "run-moved.stdout"), "sh: gsd_missing_verify_tool: command not found\n");
    writeFileSync(join(base, ".gsd", "exec", "run-moved.stderr"), "");
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [run], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("a run whose stderr reports command-not-found re-runs", async () => {
    writeCounterScript();
    // Exit 0 but the shell reported a missing command — the fresh gate
    // classifies that as an execution fault, never a pass.
    const run = matchingRun("run-missing-tool", "sha256:rev-a", {}, {
      stdout: "",
      stderr: "sh: gsd_missing_verify_tool: command not found\n",
    });
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
      reuseExecRuns: { runs: [run], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });

  test("one command without a matching run runs every command as today", async () => {
    writeCounterScript();
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh\nnpm test | tail -20",
      reuseExecRuns: { runs: [matchingRun("run-1", "sha256:rev-a")], sourceRevision: "sha256:rev-a" },
    });
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks.every((check) => check.reusedRun === undefined), true);
    assert.equal(counterCount(), 1, "the partially covered set runs in full");
  });

  test("without the reuse option the gate always runs (default off)", async () => {
    writeCounterScript();
    const result = await runVerificationGate({
      cwd: base,
      taskPlanVerify: "./count.sh",
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks[0]!.reusedRun, undefined);
    assert.equal(counterCount(), 1);
  });
});

describePosix("verificationCommandInvocation contract (#2982)", () => {
  test("the digest covers every environment variable and value", () => {
    markers.push("GSD_REUSE_DIGEST_MARKER");
    process.env.GSD_REUSE_DIGEST_MARKER = "1";
    const withMarker = verificationCommandInvocation("./count.sh", base);
    delete process.env.GSD_REUSE_DIGEST_MARKER;
    const withoutMarker = verificationCommandInvocation("./count.sh", base);
    assert.ok(withMarker && withoutMarker);
    assert.notEqual(withMarker.digest, withoutMarker.digest);
  });

  test("a different folder is a different contract", () => {
    const other = mkdtempSync(join(tmpdir(), "gsd-verification-reuse-other-"));
    try {
      const a = verificationCommandInvocation("./count.sh", base);
      const b = verificationCommandInvocation("./count.sh", other);
      assert.ok(a && b);
      assert.notEqual(a.digest, b.digest);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("Windows hosts have no contract and never reuse", () => {
    assert.equal(verificationCommandInvocation("./count.sh", base, "win32"), null);
  });

  test("the invocation is the gate's own POSIX shell form", () => {
    const invocation = verificationCommandInvocation("./count.sh", base);
    assert.ok(invocation);
    assert.equal(invocation.program, "sh");
    assert.equal(invocation.args[0], "-c");
    assert.match(invocation.args[1] ?? "", /pipefail/);
    assert.equal(invocation.args[invocation.args.length - 1], "./count.sh");
    assert.equal(invocation.rewrittenCommand, "./count.sh");
  });
});

describePosix("gsd_exec records verification contracts (#2982)", () => {
  function seedTask(verify: string): void {
    getDb().exec(`INSERT INTO milestones (id, title, status, created_at) VALUES ('M001', 'M', 'active', '2026-10-22T10:00:00.000Z')`);
    getDb().exec(`INSERT INTO slices (milestone_id, id, title, status, created_at) VALUES ('M001', 'S01', 'S', 'pending', '2026-10-22T10:00:00.000Z')`);
    getDb().exec(
      `INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify) VALUES ('M001', 'S01', 'T01', 'T', 'pending', '${verify.replaceAll("'", "''")}')`,
    );
  }

  function taskRef() {
    return { attemptId: "attempt-1", milestoneId: "M001", sliceId: "S01", taskId: "T01" };
  }

  function makeRepo(): void {
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: base });
  }

  function sourceRevision(): string {
    const source = captureMilestoneVerificationSourceRevision(base, undefined);
    assert.ok(source.ok, source.ok ? "" : source.error);
    return source.sourceRevision;
  }

  test("a Verify-matching run records its contract and runs under the gate's environment", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    const verify = 'printf "%s" "$GSD_EXEC_REUSE_MARKER"';
    seedTask(verify);
    markers.push("GSD_EXEC_REUSE_MARKER");
    process.env.GSD_EXEC_REUSE_MARKER = "gate-env-proof";

    const result = await executeGsdExec(
      { script: verify, purpose: "run verify" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.isError, false);
    const id = String(result.details?.id);
    // The sandbox allowlist would hide the marker; only the gate's full
    // environment passes it through — proving the gate-form run happened.
    const stdout = readFileSync(join(base, ".gsd", "exec", `${id}.stdout`), "utf-8");
    assert.equal(stdout, "gate-env-proof");

    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | (ExecRunRow & { attempt_ref: string | null })
      | undefined;
    assert.ok(row, "the run is recorded");
    const contract = JSON.parse(row.run_contract ?? "null") as { digest?: string } | null;
    assert.ok(contract?.digest?.startsWith("sha256:"), "a matching run stores its invocation contract");
    assert.equal(row.source_revision, sourceRevision(), "the recorded revision equals the source under test");

    // The real executor-produced row stands in for the gate end to end.
    const gate = await runVerificationGate({
      cwd: base,
      taskPlanVerify: verify,
      reuseExecRuns: { runs: [row], sourceRevision: sourceRevision() },
    });
    assert.equal(gate.passed, true, "an executor-produced contract row is reused by the gate");
    assert.equal(gate.checks[0]?.reusedRun?.runId, id);
  });

  test("without the preference the sandboxed run stores no contract", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("printf ok");

    const result = await executeGsdExec(
      { script: "printf ok" },
      { baseDir: base, preferences: null, readVerificationTaskRef: taskRef },
    );
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null }
      | undefined;
    assert.ok(row);
    assert.equal(row.run_contract, null);
  });

  test("a script that is not the Task's Verify command stores no contract", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("./count.sh");

    const result = await executeGsdExec(
      { script: "printf not-the-verify" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
      },
    );
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null }
      | undefined;
    assert.ok(row);
    assert.equal(row.run_contract, null);
  });

  test("a command that changes the source records the contract but no revision", async () => {
    makeRepo();
    writeFileSync(join(base, "source.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: base });
    execFileSync("git", ["commit", "-qm", "source"], { cwd: base });
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("touch generated.txt");

    const result = await executeGsdExec(
      { script: "touch generated.txt" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.isError, false);
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null; source_revision: string | null }
      | undefined;
    assert.ok(row);
    assert.ok(row.run_contract, "the observed run still records its contract");
    assert.equal(row.source_revision, null, "no revision when the source moved during the command");
  });

  test("a run whose output was redacted records its contract but no revision", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("echo sk-antest1234567890abcdef");

    // The persisted output is redacted, so it is not byte-faithful to what a
    // fresh gate capture would hold: the run must never be eligible.
    const result = await executeGsdExec(
      { script: "echo sk-antest1234567890abcdef" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.isError, false);
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null; source_revision: string | null }
      | undefined;
    assert.ok(row);
    assert.ok(row.run_contract, "the observed run still records its contract");
    assert.equal(row.source_revision, null, "redacted output is not byte-faithful evidence");
    const stdout = readFileSync(join(base, ".gsd", "exec", `${id}.stdout`), "utf-8");
    assert.match(stdout, /redacted/, "what persists is the redacted text");
  });

  test("a run whose output is not byte-stable UTF-8 records no revision", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    // 0xff bytes expand under a decode/re-encode; persistence must notice the
    // transform and withhold the revision.
    seedTask("printf '\\377\\377\\377 ok'");

    const result = await executeGsdExec(
      { script: "printf '\\377\\377\\377 ok'" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.isError, false);
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null; source_revision: string | null }
      | undefined;
    assert.ok(row);
    assert.ok(row.run_contract);
    assert.equal(row.source_revision, null, "non-byte-stable output is not faithful evidence");
  });

  test("a failed Verify-matching run records its contract but no revision", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("test 1 -eq 2");

    const result = await executeGsdExec(
      { script: "test 1 -eq 2" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.isError, true);
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null; source_revision: string | null; exit_code: number | null }
      | undefined;
    assert.ok(row);
    assert.equal(row.exit_code, 1);
    assert.ok(row.run_contract, "the failed run is still the newest run of this command");
    assert.equal(row.source_revision, null, "a failed run records no revision");
  });

  test("a contract run observes the gate's file-backed output", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("[ -f /dev/stdout ]");

    // Exit 0 only when stdout is a regular file — the gate's shape. Pipe-backed
    // sandbox output (the old behavior) exits 1 and fails this test.
    const result = await executeGsdExec(
      { script: "[ -f /dev/stdout ]" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.isError, false, "a contract run must see regular-file stdout like the gate");
  });

  test("without the in-process capability a Verify-matching call keeps the sandbox", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedTask("printf ok");

    const result = await executeGsdExec(
      { script: "printf ok" },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
      },
    );
    const id = String(result.details?.id);
    const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id }) as
      | { run_contract: string | null }
      | undefined;
    assert.ok(row);
    assert.equal(row.run_contract, null, "over the workflow MCP server nothing changes");
  });

  test("a contract run is not detached, exactly like the gate's spawn", async () => {
    makeRepo();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Exits 0 only when the child is its own session leader — the detached
    // sandbox shape. The gate's spawnSync is not detached, so the contract
    // run must observe the same and exit 1.
    const script = "python3 -c 'import os,sys; sys.exit(os.getsid(0) != os.getpid())'";
    seedTask(script);

    const result = await executeGsdExec(
      { script },
      {
        baseDir: base,
        preferences: { verification_reuse_exec_evidence: true },
        readVerificationTaskRef: taskRef,
        verificationRunContract: true,
      },
    );
    assert.equal(result.details?.exit_code, 1, "a contract run observes the gate's session semantics");
  });

  test("a database from before run_contract is repaired and accepts contract writes", () => {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    // The exec_runs shape as it existed before run_contract existed.
    const adapter = _getAdapter()!;
    adapter.exec("DROP TABLE exec_runs");
    adapter.exec(`
      CREATE TABLE exec_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('exec', 'uat_exec')),
        runtime TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        timed_out INTEGER NOT NULL,
        aborted INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        output_hash TEXT NOT NULL,
        milestone_id TEXT,
        slice_id TEXT,
        check_id TEXT,
        attempt_ref TEXT,
        source_revision TEXT
      )
    `);
    closeDatabase();

    // Reopening runs the startup repair, which must add the missing column.
    openDatabase(dbPath);
    recordExecRun({
      id: "run-migration",
      kind: "exec",
      runtime: "bash",
      command: "printf ok",
      cwd: base,
      exit_code: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      started_at: "2026-10-22T10:00:00.000Z",
      duration_ms: 5,
      output_hash: `sha256:${"0".repeat(64)}`,
      runContract: '{"digest":"sha256:' + "0".repeat(64) + '"}',
      sourceRevision: null,
      attemptRef: "attempt-1",
    });
    assert.equal(readExecRun("run-migration")?.run_contract, '{"digest":"sha256:' + "0".repeat(64) + '"}');
  });
});
