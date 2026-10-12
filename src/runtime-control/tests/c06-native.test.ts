// Project/App: gsd-pi
// File Purpose: C06 native command, import, cancel, answer, and S6 workspace tests.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";

import { admitCommand, getOperationByRequest } from "../admission.ts";
import { admitAnswer, registerPendingQuestion } from "../answers.ts";
import { registerCancelNativeOpsForTest } from "../cancel.ts";
import { registerIdleProbeForTest } from "../idle-probe.ts";
import { admitImport } from "../import-jobs.ts";
import { getLastMilestoneLock, registerNativeWorkflowOpsForTest } from "../native-commands.ts";
import { registerNativeAutoDispatchForTest } from "../native-auto-dispatch.ts";
import { applyPrepareDispatchBoundary, beginPrepareMode, endPrepareMode, isPrepareMode, resetPrepareModeForTest } from "../prepare-boundary.ts";
import { applyRecovery, issueRecoveryId } from "../recovery.ts";
import { buildJobSnapshot } from "../snapshots.ts";
import {
  assertTrustedGitRepo,
  canonicalRealpath,
  enforceNativeWrite,
  evaluateRead,
  evaluateWrite,
  preflightBubblewrap,
  readNeighbourFile,
  registerBubblewrapPreflightForTest,
  rejectOutOfContractTargetChanges,
  wrapManagedCommand,
} from "../workspace-profile.ts";
import { getMilestoneLockBlocker } from "../../resources/extensions/gsd/dispatch-guard.ts";
import { shouldRefuseNewWork } from "../../resources/extensions/gsd/auto-cancellation.ts";
import { createControl, reopenControl, resetC05, seedReadyProject, startRequest, tempProject, uuid } from "./harness.ts";

afterEach(() => {
  resetC05();
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function commandRequest(action: string, requestId: string, parameters: Record<string, unknown> = {}) {
  return {
    protocol_version: 1 as const,
    request_id: requestId,
    expected_revision: 1,
    expected_epoch: 1,
    action,
    parameters,
  };
}

test("AT-C05 prepare refuses execute-task and succeeds only at a validated prepared boundary", async () => {
  const product = join(tempProject("prepare-product"), "never-touch.txt");
  const alpha = tempProject("prepare");
  writeFileSync(join(alpha, "app.ts"), "export const n = 1;\n");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeWorkflowOpsForTest({
    dispatchWouldSelect: async () => ({ unitType: "execute-task", unitId: "M001/S01/T01" }),
  });

  const boundary = applyPrepareDispatchBoundary(
    { action: "dispatch", unitType: "execute-task", unitId: "M001/S01/T01" },
    { prepareMode: true, milestoneLock: "M001" },
  );
  assert.equal(boundary.kind, "prepared");

  const allowed = applyPrepareDispatchBoundary(
    { action: "dispatch", unitType: "plan-milestone", unitId: "M001" },
    { prepareMode: true, milestoneLock: "M001" },
  );
  assert.equal(allowed.kind, "allow");

  const result = await admitCommand(control, "alpha:M001", commandRequest("prepare", uuid(40)));
  assert.equal(result.ok, true);
  const stored = getOperationByRequest(control, uuid(40));
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.operation.state, "succeeded");
    assert.equal(stored.operation.result?.kind, "prepare");
    assert.equal(stored.operation.result?.boundary, "prepared");
    assert.equal(stored.operation.result?.implementation, false);
    assert.equal(stored.operation.result?.stopped_before, "execute-task");
  }
  assert.equal(readFileSync(join(alpha, "app.ts"), "utf-8"), "export const n = 1;\n");
  assert.equal(process.env.GSD_MILESTONE_LOCK, "M001");
  void product;
});

test("AT-C05 prepare mode auto dispatch stops before implementation", () => {
  beginPrepareMode("/tmp/prepare-mode", { jobId: "alpha:M001", milestoneId: "M001", operationId: "op" });
  const stopped = applyPrepareDispatchBoundary(
    { action: "dispatch", unitType: "execute-task", unitId: "M001/S01/T01" },
    { prepareMode: true, milestoneLock: "M001" },
  );
  assert.equal(stopped.kind, "prepared");
  const research = applyPrepareDispatchBoundary(
    { action: "dispatch", unitType: "research-milestone", unitId: "M001" },
    { prepareMode: true, milestoneLock: "M001" },
  );
  assert.equal(research.kind, "allow");
  endPrepareMode("/tmp/prepare-mode");
});

test("prepare mode on disk stops execute-task and still allows discussion", () => {
  const base = tempProject("prepare-disk");
  beginPrepareMode(base, { jobId: "alpha:M001", milestoneId: "M001", operationId: "op-disk" });
  resetPrepareModeForTest();
  assert.equal(isPrepareMode(base), true);
  const stopped = applyPrepareDispatchBoundary(
    { action: "dispatch", unitType: "execute-task", unitId: "M001/S01/T01" },
    { prepareMode: isPrepareMode(base), milestoneLock: "M001" },
  );
  assert.equal(stopped.kind, "prepared");
  const planning = applyPrepareDispatchBoundary(
    { action: "dispatch", unitType: "discuss-milestone", unitId: "M001" },
    { prepareMode: isPrepareMode(base), milestoneLock: "M001" },
  );
  assert.equal(planning.kind, "allow");
  endPrepareMode(base);
  assert.equal(isPrepareMode(base), false);
});

test("AT-C06 start and resume set milestoneLock and dispatch-guard rejects another milestone", async () => {
  const alpha = tempProject("scope");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const start = await admitCommand(control, "alpha:M001", startRequest(uuid(41)));
  assert.equal(start.ok, true);
  const stored = getOperationByRequest(control, uuid(41));
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.operation.result?.milestoneLock, "M001");
    assert.equal(stored.operation.result?.scoped, true);
  }
  assert.equal(process.env.GSD_MILESTONE_LOCK, "M001");
  const targetReal = control.registration.getById("alpha")?.target_realpath ?? alpha;
  assert.equal(getLastMilestoneLock(targetReal), "M001");
  assert.match(getMilestoneLockBlocker("execute-task", "M002/S01/T01") ?? "", /locked to milestone M001/);
  assert.equal(getMilestoneLockBlocker("execute-task", "M001/S01/T01"), null);

  const owner = stored.ok ? control.store.read(stored.operation.operation_id) : null;
  if (owner) {
    owner.operation.state = "succeeded";
    control.store.update(owner);
  }
  control.lease.release(stored.ok ? stored.operation.operation_id : "");
  const resume = await admitCommand(control, "alpha:M001", commandRequest("resume", uuid(42)));
  assert.equal(resume.ok, true);
  const resumed = getOperationByRequest(control, uuid(42));
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.equal(resumed.operation.result?.milestoneLock, "M001");
  }
});

test("C06 defaultStart dispatches existing native auto asynchronously when daemon mode is set", async () => {
  const alpha = tempProject("dispatch");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const calls: Array<{ basePath: string; milestoneId: string; resume: boolean }> = [];
  registerNativeAutoDispatchForTest(async (input) => {
    calls.push(input);
  });
  process.env.GSD_WEB_DAEMON_MODE = "1";
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(91)));
  assert.equal(started.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.milestoneId, "M001");
  assert.equal(calls[0]?.resume, false);
  assert.notEqual(calls[0]?.basePath, "");
});

test("AT-C07 cancel records cancelling immediately and releases the lease only after an idle probe", async () => {
  const alpha = tempProject("cancel");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  registerCancelNativeOpsForTest({
    stopAuto: async () => undefined,
    abortTools: async () => ({ cleaned: true }),
  });
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(43)));
  assert.equal(started.ok, true);
  assert.equal(control.lease.isHeld(), true);
  const cancel = await admitCommand(control, "alpha:M001", commandRequest("cancel", uuid(44)));
  assert.equal(cancel.ok, true);
  if (cancel.ok) {
    assert.equal(cancel.operation.action, "cancel");
  }
  const cancelStored = getOperationByRequest(control, uuid(44));
  assert.equal(cancelStored.ok, true);
  if (cancelStored.ok) {
    assert.equal(cancelStored.operation.state, "succeeded");
    assert.equal(cancelStored.operation.result?.kind, "cancel");
    assert.equal(cancelStored.operation.target_operation_id, started.ok ? started.operation.operation_id : null);
  }
  const target = getOperationByRequest(control, uuid(43));
  assert.equal(target.ok, true);
  if (target.ok) {
    assert.equal(target.operation.state, "cancelled");
  }
  assert.equal(control.lease.isHeld(), false);
  assert.equal(shouldRefuseNewWork(), true);
});

test("cancel retains the lease when provider abort does not complete", async () => {
  const alpha = tempProject("cancel-abort");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  registerCancelNativeOpsForTest({
    stopAuto: async () => undefined,
    abortTools: async () => ({ cleaned: true }),
    abortProvider: async () => {
      throw new Error("bridge abort failed");
    },
  });
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(147)));
  assert.equal(started.ok, true);
  const cancel = await admitCommand(control, "alpha:M001", commandRequest("cancel", uuid(148)));
  assert.equal(cancel.ok, true);
  const cancelStored = getOperationByRequest(control, uuid(148));
  assert.equal(cancelStored.ok, true);
  if (cancelStored.ok) {
    assert.equal(cancelStored.operation.state, "recovery_required");
    assert.match(String(cancelStored.operation.error?.message), /backend ownership remains uncertain/);
  }
  assert.equal(control.lease.isHeld(), true);
});

test("AT-C07 missing idle probe retains the lease as recovery_required", async () => {
  const alpha = tempProject("cancel-idle");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerCancelNativeOpsForTest({
    stopAuto: async () => undefined,
    abortTools: async () => ({ cleaned: true }),
  });
  const started = await admitCommand(control, "alpha:M001", startRequest(uuid(45)));
  assert.equal(started.ok, true);
  const cancel = await admitCommand(control, "alpha:M001", commandRequest("cancel", uuid(46)));
  assert.equal(cancel.ok, true);
  const cancelStored = getOperationByRequest(control, uuid(46));
  assert.equal(cancelStored.ok, true);
  if (cancelStored.ok) {
    assert.equal(cancelStored.operation.state, "recovery_required");
    assert.equal(cancelStored.operation.error?.code, "recovery_required");
    assert.equal(typeof cancelStored.operation.result?.recovery_id, "string");
  }
  assert.equal(control.lease.isHeld(), true);
});

test("recover releases a recovery_required lease only after an idle probe", async () => {
  const alpha = tempProject("recover-idle");
  const { control, stateRoot } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  const binding = control.registration.getById("alpha")?.backend_binding ?? null;
  assert.ok(binding);
  control.store.writeAccepted({
    operation: {
      protocol_version: 1,
      operation_id: "op-held",
      request_id: uuid(900),
      job_id: "alpha:M001",
      action: "start",
      state: "recovery_required",
      admitted_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      result: null,
      error: null,
      target_operation_id: null,
    },
    fingerprint: "bound-op-held",
    kind: "job-command",
    dispatch_intent: false,
    backend_binding: binding,
  });
  control.lease.acquire({
    operation_id: "op-held",
    job_id: "alpha:M001",
    action: "start",
    acquired_at: "2026-09-20T00:00:00Z",
    recovery_required: true,
    backend_binding: binding,
  });
  const blocked = issueRecoveryId({
    operation_id: "op-held",
    job_id: "alpha:M001",
    reason: "Could not parse /slots idle signal",
    issued_at: "2026-09-20T00:00:01Z",
    next_state: "recovery_required",
  });
  const reopened = reopenControl(stateRoot, [
    { project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" },
  ]);
  const snapshot = await buildJobSnapshot(reopened, "alpha:M001");
  const recoverAction = snapshot.actions.find((action) => action.id === "recover");
  assert.deepEqual(recoverAction?.parameters, { recovery_id: blocked.recovery_id });
  registerCancelNativeOpsForTest({
    abortOwnedWorker: async (input) => ({
      cleaned: true,
      dispatch_quiesced: true,
      request_closed: true,
      tools_drained: true,
      operation_id: input.operationId,
      job_id: input.jobId,
      session_id: null,
      worker_generation: 1,
      reason: null,
    }),
  });
  registerIdleProbeForTest(async () => ({ idle: false, source: "slots", reason: "A backend slot is still processing" }));
  const refused = await admitCommand(control, "alpha:M001", commandRequest("recover", uuid(247), {
    recovery_id: blocked.recovery_id,
  }));
  assert.equal(refused.ok, true);
  assert.equal(control.lease.isHeld(), true);
  const refusedStored = getOperationByRequest(control, uuid(247));
  assert.equal(refusedStored.ok, true);
  if (refusedStored.ok) assert.equal(refusedStored.operation.state, "recovery_required");

  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const released = await admitCommand(control, "alpha:M001", commandRequest("recover", uuid(248), {
    recovery_id: blocked.recovery_id,
  }));
  assert.equal(released.ok, true);
  assert.equal(control.lease.isHeld(), false);
  const releasedStored = getOperationByRequest(control, uuid(248));
  assert.equal(releasedStored.ok, true);
  if (releasedStored.ok) {
    assert.equal(releasedStored.operation.state, "succeeded");
    assert.equal(releasedStored.operation.result?.replayed_shell, false);
    assert.equal(releasedStored.operation.result?.idle_confirmed, true);
  }
});

test("recover releases when the stalled start never created a worker and the slot is idle", async () => {
  const alpha = tempProject("recover-no-worker");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  const binding = control.registration.getById("alpha")?.backend_binding ?? null;
  assert.ok(binding);
  control.store.writeAccepted({
    operation: {
      protocol_version: 1,
      operation_id: "op-stalled",
      request_id: uuid(901),
      job_id: "alpha:M001",
      action: "start",
      state: "recovery_required",
      admitted_at: "2026-09-24T20:52:46Z",
      updated_at: "2026-09-24T20:52:47Z",
      result: { kind: "start", milestoneLock: "M001", scoped: true },
      error: null,
      target_operation_id: null,
    },
    fingerprint: "bound-op-stalled",
    kind: "job-command",
    dispatch_intent: true,
    backend_binding: binding,
  });
  control.lease.acquire({
    operation_id: "op-stalled",
    job_id: "alpha:M001",
    action: "start",
    acquired_at: "2026-09-24T20:52:46Z",
    recovery_required: true,
    backend_binding: binding,
  });
  const recovery = issueRecoveryId({
    operation_id: "op-stalled",
    job_id: "alpha:M001",
    reason: "missing worker; abort did not create one",
    issued_at: "2026-09-25T02:45:58Z",
    next_state: "recovery_required",
  });
  registerCancelNativeOpsForTest({
    abortOwnedWorker: async () => ({
      cleaned: false,
      dispatch_quiesced: false,
      request_closed: false,
      tools_drained: false,
      operation_id: null,
      job_id: null,
      session_id: null,
      worker_generation: null,
      reason: "missing worker; abort did not create one",
    }),
  });
  registerIdleProbeForTest(async () => ({ idle: false, source: "slots", reason: "A backend slot is still processing" }));
  const busy = await admitCommand(control, "alpha:M001", commandRequest("recover", uuid(249), {
    recovery_id: recovery.recovery_id,
  }));
  assert.equal(busy.ok, true);
  assert.equal(control.lease.isHeld(), true);

  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const released = await admitCommand(control, "alpha:M001", commandRequest("recover", uuid(250), {
    recovery_id: recovery.recovery_id,
  }));
  assert.equal(released.ok, true);
  assert.equal(control.lease.isHeld(), false);
});

test("AT-C07 recover applies an issued recovery_id and never invents a shell replay", async () => {
  const alpha = tempProject("recover");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const recovery = issueRecoveryId({
    operation_id: "op-recover",
    job_id: "alpha:M001",
    reason: "cancelled cleanup failed",
    issued_at: "2026-09-20T00:00:00Z",
    next_state: "idle",
  });
  const result = await admitCommand(control, "alpha:M001", commandRequest("recover", uuid(47), {
    recovery_id: recovery.recovery_id,
  }));
  assert.equal(result.ok, true);
  const stored = getOperationByRequest(control, uuid(47));
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.operation.state, "succeeded");
    assert.equal(stored.operation.result?.kind, "recover");
    assert.equal(stored.operation.result?.replayed_shell, false);
    assert.equal(stored.operation.result?.recovery_id, recovery.recovery_id);
  }
});

test("idle recover cancels sibling recovery_required ops on the same job", async () => {
  const alpha = tempProject("recover-sibling");
  const { control } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  const binding = control.registration.getById("alpha")?.backend_binding ?? null;
  assert.ok(binding);
  control.store.writeAccepted({
    operation: {
      protocol_version: 1,
      operation_id: "op-cancel-owner",
      request_id: uuid(260),
      job_id: "alpha:M001",
      action: "cancel",
      state: "cancelled",
      admitted_at: "2026-10-12T17:37:25Z",
      updated_at: "2026-10-12T17:37:43Z",
      result: { kind: "cancel", cancelled: true },
      error: null,
      target_operation_id: "op-resume",
    },
    fingerprint: "bound-op-cancel-owner",
    kind: "job-command",
    dispatch_intent: false,
    backend_binding: binding,
  });
  const recovery = issueRecoveryId({
    operation_id: "op-cancel-owner",
    job_id: "alpha:M001",
    reason: "A backend slot is still processing",
    issued_at: "2026-10-12T17:37:43Z",
    next_state: "recovery_required",
  });
  control.store.writeAccepted({
    operation: {
      protocol_version: 1,
      operation_id: "op-orphan-recover",
      request_id: uuid(261),
      job_id: "alpha:M001",
      action: "recover",
      state: "recovery_required",
      admitted_at: "2026-10-12T17:41:00Z",
      updated_at: "2026-10-12T17:41:16Z",
      result: {
        kind: "recover",
        recovery_id: recovery.recovery_id,
        next_state: "recovery_required",
        idle_confirmed: false,
        replayed_shell: false,
      },
      error: {
        code: "recovery_required",
        message: "A backend slot is still processing",
        retryable: false,
        operation_id: "op-orphan-recover",
      },
      target_operation_id: null,
    },
    fingerprint: "bound-op-orphan-recover",
    kind: "job-command",
    dispatch_intent: false,
    backend_binding: null,
  });
  registerCancelNativeOpsForTest({
    abortOwnedWorker: async (input) => ({
      cleaned: true,
      dispatch_quiesced: true,
      request_closed: true,
      tools_drained: true,
      operation_id: input.operationId,
      job_id: input.jobId,
      session_id: null,
      worker_generation: 1,
      reason: null,
    }),
  });
  registerIdleProbeForTest(async () => ({ idle: true, source: "slots" }));
  const released = await admitCommand(control, "alpha:M001", commandRequest("recover", uuid(262), {
    recovery_id: recovery.recovery_id,
  }));
  assert.equal(released.ok, true);
  const orphan = control.store.read("op-orphan-recover");
  assert.equal(orphan?.operation.state, "cancelled");
  assert.equal(orphan?.operation.result?.reconciled, true);
  assert.equal(orphan?.operation.result?.idle_confirmed, true);
});

test("startup cancels orphan recovery_required when recovery_id already applied", async () => {
  const alpha = tempProject("recover-orphan-startup");
  const { control, stateRoot } = createControl({
    projects: [{ project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" }],
  });
  seedReadyProject(control, "alpha", alpha);
  const recovery = issueRecoveryId({
    operation_id: "op-cancel-owner",
    job_id: "alpha:M001",
    reason: "A backend slot is still processing",
    issued_at: "2026-10-12T17:37:43Z",
    next_state: "recovery_required",
  });
  control.store.writeAccepted({
    operation: {
      protocol_version: 1,
      operation_id: "op-orphan-recover",
      request_id: uuid(263),
      job_id: "alpha:M001",
      action: "recover",
      state: "recovery_required",
      admitted_at: "2026-10-12T17:41:00Z",
      updated_at: "2026-10-12T17:41:16Z",
      result: {
        kind: "recover",
        recovery_id: recovery.recovery_id,
        next_state: "recovery_required",
        idle_confirmed: false,
        replayed_shell: false,
      },
      error: {
        code: "recovery_required",
        message: "A backend slot is still processing",
        retryable: false,
        operation_id: "op-orphan-recover",
      },
      target_operation_id: null,
    },
    fingerprint: "bound-op-orphan-startup",
    kind: "job-command",
    dispatch_intent: false,
    backend_binding: null,
  });
  applyRecovery(recovery.recovery_id);
  assert.equal(control.store.read("op-orphan-recover")?.operation.state, "recovery_required");
  const reopened = reopenControl(stateRoot, [
    { project_id: "alpha", target: alpha, backend_idle_probe: "http://127.0.0.1/slots" },
  ]);
  const cleared = reopened.store.read("op-orphan-recover");
  assert.equal(cleared?.operation.state, "cancelled");
  assert.equal(cleared?.operation.result?.reconciled, true);
  const snapshot = await buildJobSnapshot(reopened, "alpha:M001");
  assert.notEqual(snapshot.state, "recovery_required");
});

test("AT-C08 answers validate scope, epoch, and duplicate values without a second lease", async () => {
  const alpha = tempProject("answers");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerPendingQuestion({ question_id: "q1", job_id: "alpha:M001", session_id: "s1" });

  const stale = await admitAnswer(control, "alpha:M001", {
    question_id: "q1",
    request_id: uuid(48),
    expected_revision: 1,
    expected_epoch: 9,
    response: { choice: "a" },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, 409);

  const first = await admitAnswer(control, "alpha:M001", {
    question_id: "q1",
    request_id: uuid(49),
    expected_revision: 1,
    expected_epoch: 1,
    response: { choice: "a" },
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.operation.result?.kind, "answer");
    assert.equal(first.status, 202);
  }
  assert.equal(control.lease.isHeld(), false);

  const duplicateSame = await admitAnswer(control, "alpha:M001", {
    question_id: "q1",
    request_id: uuid(49),
    expected_revision: 1,
    expected_epoch: 1,
    response: { choice: "a" },
  });
  assert.equal(duplicateSame.ok, true);
  if (duplicateSame.ok && first.ok) {
    assert.equal(duplicateSame.operation.operation_id, first.operation.operation_id);
  }

  const duplicateDifferent = await admitAnswer(control, "alpha:M001", {
    question_id: "q1",
    request_id: uuid(49),
    expected_revision: 1,
    expected_epoch: 1,
    response: { choice: "b" },
  });
  assert.equal(duplicateDifferent.ok, false);
  if (!duplicateDifferent.ok) {
    assert.equal(duplicateDifferent.status, 409);
    assert.equal(duplicateDifferent.body.error.code, "request_id_conflict");
  }
  assert.equal(control.lease.isHeld(), false);
});

test("import refuses changed data over an active milestone without replan", async () => {
  const alpha = tempProject("import-conflict");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  const content = "one";
  const digest = sha256("digest-one");
  const first = await admitImport(control, "alpha", {
    protocol_version: 1,
    request_id: uuid(50),
    import_digest: digest,
    spec_id: "alpha--custom",
    title: "One",
    source: { kind: "prompt", path: "a.md", sha256: sha256("a") },
    tasks: [],
    source_job_status: "running",
    documents: [{ path: "a.md", content, sha256: sha256(content) }],
  });
  assert.equal(first.ok, true);

  const changed = await admitImport(control, "alpha", {
    protocol_version: 1,
    request_id: uuid(51),
    import_digest: digest,
    spec_id: "alpha--custom",
    title: "Two",
    source: { kind: "prompt", path: "a.md", sha256: sha256("a") },
    tasks: [{ id: "changed" }],
    source_job_status: "running",
    documents: [{ path: "a.md", content, sha256: sha256(content) }],
  });
  assert.equal(changed.ok, false);
  if (!changed.ok) {
    assert.equal(changed.status, 409);
  }
});

test("AT-W01 native writes honour target, scratch, and read-only neighbours; shell fails closed without bwrap", async () => {
  const target = tempProject("w01-target");
  const neighbour = tempProject("w01-neighbour");
  const scratch = tempProject("w01-scratch");
  writeFileSync(join(neighbour, "ref.txt"), "neighbour-bytes");
  writeFileSync(join(target, "app.ts"), "target");
  const { control } = createControl({
    projects: [{
      project_id: "alpha",
      target,
      references: [{ project_id: "neighbour", root: neighbour }],
      writable_cache_roots: [scratch],
    }],
  });
  void control;
  assert.equal(evaluateWrite(join(target, "app.ts"), target).allow, true);
  enforceNativeWrite(join(target, "app.ts"), target);
  enforceNativeWrite(join(scratch, "cache.bin"), target);
  assert.equal(evaluateRead(join(neighbour, "ref.txt"), target).allow, true);
  assert.equal(readNeighbourFile(join(neighbour, "ref.txt"), target), "neighbour-bytes");
  assert.equal(evaluateWrite(join(neighbour, "ref.txt"), target).allow, false);
  assert.throws(() => enforceNativeWrite(join(neighbour, "ref.txt"), target), /read-only neighbour/);
  assert.equal(readFileSync(join(neighbour, "ref.txt"), "utf-8"), "neighbour-bytes");
  assertTrustedGitRepo(target, target);
  assert.throws(() => assertTrustedGitRepo(neighbour, target), /neighbouring product/);

  const preflight = preflightBubblewrap();
  if (process.platform === "linux") {
    assert.equal(preflight.ok, true);
    const payload = `from pathlib import Path\nPath(${JSON.stringify(join(neighbour, "ref.txt"))}).write_text('owned\\n')\n`;
    const wrapped = wrapManagedCommand(target, "/usr/bin/python3", ["-c", payload]);
    assert.equal(wrapped.ok, true);
    if (wrapped.ok) {
      assert.equal(wrapped.file, "bwrap");
      assert.ok(wrapped.args.includes("--ro-bind"));
      assert.ok(wrapped.args.includes(canonicalRealpath(neighbour)));
      const ran = spawnSync(wrapped.file, wrapped.args, { encoding: "utf-8" });
      assert.notEqual(ran.status, 0);
      assert.match(`${ran.stderr}\n${ran.stdout}`, /Read-only file system|EROFS|Errno 30/i);
    }
    assert.equal(readFileSync(join(neighbour, "ref.txt"), "utf-8"), "neighbour-bytes");
  } else {
    const blocked = wrapManagedCommand(target, "python3", ["-c", "print(1)"]);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.match(blocked.diagnostics, /bubblewrap|bwrap|user-namespace|Linux/i);
    }
    assert.equal(preflight.ok, false);
  }
});

test("AT-W01 plan/review cannot mutate product files; out-of-contract diffs are rejected in place", async () => {
  const target = tempProject("w01-review");
  const neighbour = tempProject("w01-review-ref");
  const { control } = createControl({
    projects: [{
      project_id: "alpha",
      target,
      references: [{ project_id: "neighbour", root: neighbour }],
    }],
  });
  seedReadyProject(control, "alpha", target);
  writeFileSync(join(target, "product.ts"), "ok");
  const review = await admitCommand(control, "alpha:M001", commandRequest("review", uuid(52)));
  assert.equal(review.ok, true);
  assert.equal(evaluateWrite(join(target, "product.ts"), target).allow, false);
  assert.equal(evaluateWrite(join(target, ".gsd", "plan.md"), target).allow, true);
  const findings = rejectOutOfContractTargetChanges(
    {
      projectId: "alpha",
      targetRealpath: canonicalRealpath(target),
      referenceRealpaths: [canonicalRealpath(neighbour)],
      cacheRealpaths: [],
      phase: "implement",
      allowedEdits: ["src/**"],
    },
    ["secret.txt"],
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.reason ?? "", /not deleted/);
});

test("AT-W02 traversal, symlink alias, and absolute neighbour paths are rejected after realpath", () => {
  const target = tempProject("w02-target");
  const neighbour = tempProject("w02-neighbour");
  writeFileSync(join(neighbour, "secret.txt"), "untouched");
  mkdirSync(join(target, "sub"), { recursive: true });
  createControl({
    projects: [{
      project_id: "alpha",
      target,
      references: [{ project_id: "neighbour", root: neighbour }],
    }],
  });
  const escaped = join(target, "..", basename(neighbour), "secret.txt");
  assert.equal(evaluateWrite(join(target, "..", "nope.ts"), target).allow, false);
  assert.throws(() => enforceNativeWrite(escaped, target), /read-only neighbour|outside the registered workspace/);
  symlinkSync(neighbour, join(target, "alias"));
  assert.throws(() => enforceNativeWrite(join(target, "alias", "secret.txt"), target), /read-only neighbour/);
  assert.throws(() => enforceNativeWrite(join(neighbour, "secret.txt"), target), /read-only neighbour/);
  assert.equal(readFileSync(join(neighbour, "secret.txt"), "utf-8"), "untouched");
  if (process.platform === "linux") {
    const payload = `from pathlib import Path\nPath(${JSON.stringify(join(target, "alias", "secret.txt"))}).write_text('owned\\n')\n`;
    const wrapped = wrapManagedCommand(target, "/usr/bin/python3", ["-c", payload]);
    assert.equal(wrapped.ok, true);
    if (wrapped.ok) {
      const ran = spawnSync(wrapped.file, wrapped.args, { encoding: "utf-8" });
      assert.notEqual(ran.status, 0);
      assert.match(`${ran.stderr}\n${ran.stdout}`, /Read-only file system|EROFS|Errno 30/i);
    }
    assert.equal(readFileSync(join(neighbour, "secret.txt"), "utf-8"), "untouched");
  }
});

test("registration rejects within-project target and reference aliases", () => {
  const shared = tempProject("alias-root");
  assert.throws(() => {
    createControl({
      projects: [{
        project_id: "alpha",
        target: shared,
        references: [{ project_id: "self", root: shared }],
      }],
    });
  }, /aliased workspace roots|Overlapping/);
});

test("review success is typed findings, not a prompt acknowledgement", async () => {
  const alpha = tempProject("review");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  registerNativeWorkflowOpsForTest({
    publishReviewFindings: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { findings: [{ id: "n1", summary: "ok" }], productMutated: false, executed: true };
    },
  });
  const result = await admitCommand(control, "alpha:M001", commandRequest("review", uuid(53)));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.operation.state, "running");
  await new Promise((resolve) => setImmediate(resolve));
  const stored = getOperationByRequest(control, uuid(53));
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.operation.state, "succeeded");
    assert.equal(stored.operation.result?.kind, "review");
    assert.equal(stored.operation.result?.product_mutated, false);
    assert.deepEqual(stored.operation.result?.findings, [{ id: "n1", summary: "ok" }]);
  }
});

test("replan does not succeed from evidence invalidation alone", async () => {
  const alpha = tempProject("replan");
  mkdirSync(join(alpha, ".gsd", "evidence"), { recursive: true });
  writeFileSync(join(alpha, ".gsd", "evidence", "M001-host.json"), "{}");
  const { control } = createControl({ projects: [{ project_id: "alpha", target: alpha }] });
  seedReadyProject(control, "alpha", alpha);
  const before = control.jobs.require("alpha:M001").revision;
  const result = await admitCommand(control, "alpha:M001", commandRequest("replan", uuid(54), { reason: "scope-change" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.operation.state, "failed");
    assert.match(result.operation.error?.message ?? "", /not registered/);
  }
  assert.equal(control.jobs.require("alpha:M001").revision, before);
  assert.equal(existsSync(join(alpha, ".gsd", "runtime", "invalidated-evidence", "M001.json")), false);
});

test("injected bwrap preflight still does not run unrestricted neighbour writes", () => {
  const target = tempProject("bwrap-inject");
  const neighbour = tempProject("bwrap-neighbour");
  createControl({
    projects: [{
      project_id: "alpha",
      target,
      references: [{ project_id: "neighbour", root: neighbour }],
    }],
  });
  registerBubblewrapPreflightForTest({ ok: true, bwrap: "/usr/bin/bwrap" });
  const wrapped = wrapManagedCommand(target, "python3", ["-c", "open('x','w')"]);
  assert.equal(wrapped.ok, true);
  if (wrapped.ok) {
    assert.equal(wrapped.file, "bwrap");
    assert.ok(wrapped.args.includes("--ro-bind"));
    assert.ok(wrapped.args.includes(canonicalRealpath(neighbour)));
  }
});
