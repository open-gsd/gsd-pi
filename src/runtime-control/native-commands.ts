// Project/App: gsd-pi
// File Purpose: Typed runtime-v1 command adapters over existing GSD domain functions.

import { evaluateCompulsoryPolicy } from "../resources/extensions/gsd/required-policy.ts";
import { beginPrepareMode, endPrepareMode, isImplementationUnit, readPrepareBoundaryStop } from "./prepare-boundary.ts";
import { acknowledgeOwnedWorker, executeCancel, probeIdleWithinTeardown } from "./cancel.ts";
import { applyRecovery, getRecovery, issueRecoveryId } from "./recovery.ts";
import type { CommandAction, CommandRequest, JobRecord, Operation, ResolvedProject, StoredOperation } from "./types.ts";
import type { JobCatalog } from "./job-catalog.ts";
import type { ModelLease } from "./model-lease.ts";
import type { OperationStore } from "./operation-store.ts";
import { setWorkspacePhase } from "./workspace-profile.ts";
import { dispatchNativeScopedAuto, NativeDispatchError } from "./native-auto-dispatch.ts";
import { ingestNativeEvent } from "./event-hub.ts";
import type { RuntimeControl } from "./control.ts";

export type CommandHost = {
  store: OperationStore;
  lease: ModelLease;
  jobs: JobCatalog;
  clock: () => Date;
  stateRoot?: string;
};

export type NativeCommandContext = {
  operation: Operation;
  request: CommandRequest;
  job: JobRecord;
  project: ResolvedProject;
  host: CommandHost;
};

export type NativeCommandResult = {
  dispatch?: boolean;
  holdLease?: boolean;
};

export type NativeStartResult = {
  started: boolean;
  milestoneLock: string;
  dispatch?: Promise<void>;
};

export type NativeReviewResult = {
  findings: unknown[];
  productMutated: boolean;
  executed?: boolean;
};

export type NativeReplanResult = {
  preservedCompleted: boolean;
  evidenceInvalidated: string[];
  revision?: number;
};

export type NativeWorkflowOps = {
  startScopedAuto?: (input: { basePath: string; milestoneId: string; resume: boolean }) => Promise<NativeStartResult>;
  publishReviewFindings?: (input: {
    basePath: string;
    milestoneId: string;
    operationId: string;
    jobId: string;
    revision: number;
  }) => Promise<NativeReviewResult>;
  replanMilestone?: (input: {
    basePath: string;
    milestoneId: string;
    reason: string;
    operationId: string;
    jobId: string;
    revision: number;
  }) => Promise<NativeReplanResult>;
  dispatchWouldSelect?: (input: { basePath: string; milestoneId: string }) => Promise<{ unitType: string; unitId: string } | null>;
};

const lastMilestoneLock = new Map<string, string>();
let nativeOps: NativeWorkflowOps = {};

export function registerNativeWorkflowOps(ops: NativeWorkflowOps): void {
  nativeOps = { ...nativeOps, ...ops };
}

export function registerNativeWorkflowOpsForTest(ops: NativeWorkflowOps | null): void {
  nativeOps = ops ?? {};
}

export function resetNativeWorkflowOpsForTest(): void {
  nativeOps = {};
  lastMilestoneLock.clear();
}

export function getLastMilestoneLock(basePath: string): string | undefined {
  return lastMilestoneLock.get(basePath);
}

function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function storedFromContext(context: NativeCommandContext): StoredOperation | undefined {
  return context.host.store.read(context.operation.operation_id);
}

type DefaultStartInput = {
  basePath: string;
  milestoneId: string;
  resume: boolean;
  onEvent?: (event: unknown) => void;
};

async function defaultStart(input: DefaultStartInput): Promise<NativeStartResult> {
  lastMilestoneLock.set(input.basePath, input.milestoneId);
  process.env.GSD_MILESTONE_LOCK = input.milestoneId;
  const dispatch = dispatchNativeScopedAuto(input).then((result) => {
    if (result.dispatched) return;
    if (process.env.GSD_WEB_DAEMON_MODE === "1") {
      throw new NativeDispatchError("native auto was not dispatched", false);
    }
  });
  return { started: true, milestoneLock: input.milestoneId, dispatch };
}

function recordBridgeEvent(context: NativeCommandContext, event: unknown): void {
  if (!event || typeof event !== "object" || !("type" in event)) return;
  const native = event as Record<string, unknown>;
  const type = typeof native.type === "string" ? native.type : "";
  if (!type || type === "bridge_status" || type === "live_state_invalidation") return;

  const payload: Record<string, unknown> = {};
  if (type === "tool_execution_start" || type === "tool_execution_end" || type === "tool_execution_update") {
    payload.tool = native.toolName;
    payload.name = native.toolName;
    payload.input = native.args ?? native.input;
    payload.output = native.result;
    payload.ok = native.isError !== true;
    if (native.isError === true) payload.error = native.error ?? native.result ?? true;
  } else if (type === "message_end" || type === "assistant_message") {
    const message = native.message;
    if (message && typeof message === "object") {
      const record = message as { role?: unknown; content?: unknown };
      if (typeof record.role === "string" && record.role !== "assistant") return;
      if (typeof record.content === "string") {
        payload.text = record.content;
      } else if (Array.isArray(record.content)) {
        payload.text = record.content
          .filter((item): item is { type?: string; text?: string } => Boolean(item && typeof item === "object"))
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n");
      }
    } else if (typeof native.text === "string") payload.text = native.text;
  } else if (type === "extension_ui_request") {
    if (!["select", "confirm", "input", "editor"].includes(String(native.method ?? ""))) return;
    payload.method = native.method;
    payload.id = native.id;
    payload.title = native.title;
    payload.message = native.message;
    payload.options = native.options;
    payload.placeholder = native.placeholder;
    payload.prefill = native.prefill;
    payload.allowMultiple = native.allowMultiple;
    payload.secure = native.secure;
  }

  if (!context.host.stateRoot) return;
  ingestNativeEvent(context.host as RuntimeControl, {
    type,
    project_id: context.job.project_id,
    job_id: context.job.job_id,
    operation_id: context.operation.operation_id,
    attempt_id: context.operation.operation_id,
    task_id: typeof native.task_id === "string" ? native.task_id : null,
    message_id: typeof native.message_id === "string"
      ? native.message_id
      : typeof native.messageId === "string"
        ? native.messageId
        : null,
    revision: context.job.revision,
    authority_epoch: context.job.authority_epoch,
    payload,
    assistantMessageEvent: native.assistantMessageEvent && typeof native.assistantMessageEvent === "object"
      ? native.assistantMessageEvent as { type?: string; delta?: string; contentIndex?: number }
      : undefined,
  });
}

function failOperation(host: CommandHost, stored: StoredOperation, code: "runtime_unavailable" | "recovery_required" | "invalid_contract", message: string): void {
  stored.operation.state = code === "recovery_required" ? "recovery_required" : "failed";
  stored.operation.updated_at = nowIso(host.clock);
  stored.operation.error = {
    code,
    message,
    retryable: false,
    operation_id: stored.operation.operation_id,
  };
  host.store.update(stored);
}

export function settleNativeDispatchFailure(host: CommandHost, operationId: string, error: unknown): void {
  const stored = host.store.read(operationId);
  if (!stored) return;
  if (stored.operation.state !== "running" && stored.operation.state !== "accepted") return;
  const began = error instanceof NativeDispatchError ? error.sideEffectsBegan : true;
  const message = error instanceof Error ? error.message : String(error);
  if (began) {
    const recovery = issueCrashRecovery(host, operationId, stored.operation.job_id, message);
    stored.operation.state = "recovery_required";
    stored.operation.updated_at = nowIso(host.clock);
    stored.operation.error = {
      code: "recovery_required",
      message,
      retryable: false,
      operation_id: operationId,
    };
    stored.operation.result = { ...(stored.operation.result ?? {}), recovery_id: recovery.recovery_id };
    host.store.update(stored);
    host.lease.retainForRecovery(operationId);
    return;
  }
  failOperation(host, stored, "runtime_unavailable", message);
  const held = host.lease.current();
  if (held?.operation_id === operationId) host.lease.release(operationId);
}

function observeDispatch(host: CommandHost, operationId: string, dispatch: Promise<void> | undefined): void {
  if (!dispatch) return;
  void dispatch.catch((error) => {
    settleNativeDispatchFailure(host, operationId, error);
  });
}

export function settlePrepareBoundary(host: CommandHost, basePath: string): boolean {
  const stop = readPrepareBoundaryStop(basePath);
  if (!stop) return false;
  const stored = host.store.read(stop.operationId);
  if (!stored || stored.operation.action !== "prepare") return false;
  if (stored.operation.state === "succeeded" && stored.operation.result?.boundary === "prepared") {
    endPrepareMode(basePath);
    return true;
  }
  if (stored.operation.state !== "running") return false;
  stored.operation.state = "succeeded";
  stored.operation.updated_at = nowIso(host.clock);
  stored.operation.result = {
    kind: "prepare",
    boundary: "prepared",
    stopped_before: stop.unitType,
    unit_id: stop.unitId ?? null,
    implementation: false,
  };
  host.store.update(stored);
  const held = host.lease.current();
  if (held?.operation_id === stop.operationId) host.lease.release(stop.operationId);
  endPrepareMode(basePath);
  return true;
}

function reconcileIdleRecovery(
  host: CommandHost,
  recoveryOperationId: string,
  jobId: string | null,
  recoveryId: string,
  updatedAt: string,
): void {
  const held = host.lease.current();
  const ids = new Set<string>();
  if (held && (held.operation_id === recoveryOperationId || (jobId !== null && held.job_id === jobId))) {
    ids.add(held.operation_id);
    host.lease.release(held.operation_id);
  }
  ids.add(recoveryOperationId);
  // Prior failed recover ops stay LIVE as recovery_required and otherwise block
  // the job after a later idle recover succeeds. Clear every sibling on the job.
  if (jobId) {
    for (const sibling of host.store.listForJob(jobId)) {
      if (sibling.operation.state === "recovery_required") {
        ids.add(sibling.operation.operation_id);
      }
    }
  }
  for (const operationId of ids) {
    const stored = host.store.read(operationId);
    if (!stored || stored.operation.state !== "recovery_required") continue;
    stored.operation.state = "cancelled";
    stored.operation.updated_at = updatedAt;
    stored.operation.result = {
      ...(stored.operation.result ?? {}),
      reconciled: true,
      idle_confirmed: true,
      recovery_id: recoveryId,
    };
    host.store.update(stored);
  }
}

export async function productionCommandHandler(context: NativeCommandContext): Promise<NativeCommandResult> {
  const stored = storedFromContext(context);
  if (!stored) return { dispatch: false, holdLease: false };
  const action = context.request.action as CommandAction;
  const basePath = context.project.target_realpath;
  const milestoneId = context.job.milestone_id;

  if (action === "cancel") {
    const result = await executeCancel({ host: context.host, project: context.project, cancelOperation: stored });
    return { dispatch: false, holdLease: result.holdLease };
  }

  if (action === "recover") {
    const recoveryId = String(context.request.parameters.recovery_id ?? "");
    const diagnostic = getRecovery(recoveryId);
    if (!diagnostic) {
      stored.operation.state = "failed";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.error = {
        code: "invalid_request",
        message: `recovery_id ${recoveryId} was not issued by native diagnostics`,
        retryable: false,
        operation_id: stored.operation.operation_id,
      };
      context.host.store.update(stored);
      return { dispatch: false, holdLease: false };
    }
    const owner = context.host.store.read(diagnostic.operation_id);
    if ((diagnostic.job_id && diagnostic.job_id !== context.job.job_id) || (owner && owner.operation.job_id !== context.job.job_id)) {
      stored.operation.state = "failed";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.error = {
        code: "invalid_request",
        message: "recover does not match the owning job",
        retryable: false,
        operation_id: stored.operation.operation_id,
      };
      context.host.store.update(stored);
      return { dispatch: false, holdLease: true };
    }
    if (!owner) {
      const blockedAt = nowIso(context.host.clock);
      stored.operation.state = "recovery_required";
      stored.operation.updated_at = blockedAt;
      stored.operation.error = {
        code: "recovery_required",
        message: "The recovery diagnostic's owning operation is unavailable; ownership remains unresolved.",
        retryable: false,
        operation_id: stored.operation.operation_id,
      };
      context.host.store.update(stored);
      return { dispatch: false, holdLease: true };
    }
    if (diagnostic.next_state === "recovery_required") {
      const target = owner?.operation.target_operation_id
        ? context.host.store.read(owner.operation.target_operation_id)
        : undefined;
      const binding = owner.backend_binding ?? target?.backend_binding ?? null;
      if (!binding) {
        const blockedAt = nowIso(context.host.clock);
        stored.operation.state = "recovery_required";
        stored.operation.updated_at = blockedAt;
        stored.operation.error = {
          code: "recovery_required",
          message: "Operation has no backend binding; ownership is unknown. Retain recovery_required.",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        stored.operation.result = {
          kind: "recover",
          recovery_id: recoveryId,
          next_state: "recovery_required",
          idle_confirmed: false,
          replayed_shell: false,
        };
        context.host.store.update(stored);
        return { dispatch: false, holdLease: true };
      }
      let evidence = await acknowledgeOwnedWorker({
        projectCwd: context.project.target_realpath,
        operationId: owner.operation.operation_id,
        jobId: context.job.job_id,
      });
      const prior = owner.operation.result;
      if (
        !evidence.cleaned
        && (evidence.reason ?? "").includes("missing worker")
        && prior?.dispatch_quiesced === true
        && prior.request_closed === true
        && prior.tools_drained === true
      ) {
        evidence = {
          ...evidence,
          cleaned: true,
          dispatch_quiesced: true,
          request_closed: true,
          tools_drained: true,
        };
      }
      if (
        !evidence.cleaned
        && (evidence.reason ?? "").includes("abort did not create one")
        && evidence.worker_generation == null
      ) {
        const absent = await probeIdleWithinTeardown(binding);
        if (absent.idle) {
          evidence = {
            ...evidence,
            cleaned: true,
            dispatch_quiesced: true,
            request_closed: true,
            tools_drained: true,
            reason: null,
          };
        }
      }
      const idle = evidence.cleaned ? await probeIdleWithinTeardown(binding) : null;
      if (!evidence.cleaned || !idle?.idle) {
        const blockedAt = nowIso(context.host.clock);
        stored.operation.state = "recovery_required";
        stored.operation.updated_at = blockedAt;
        stored.operation.error = {
          code: "recovery_required",
          message: !evidence.cleaned
            ? (evidence.reason ?? "worker cleanup was not acknowledged")
            : (idle && !idle.idle ? idle.reason : "backend ownership remains uncertain"),
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        stored.operation.result = {
          kind: "recover",
          recovery_id: recoveryId,
          next_state: "recovery_required",
          idle_confirmed: false,
          replayed_shell: false,
          dispatch_quiesced: evidence.dispatch_quiesced,
          request_closed: evidence.request_closed,
          tools_drained: evidence.tools_drained,
        };
        context.host.store.update(stored);
        return { dispatch: false, holdLease: true };
      }
    }
    const applied = applyRecovery(recoveryId);
    const recoveredAt = nowIso(context.host.clock);
    stored.operation.state = "succeeded";
    stored.operation.updated_at = recoveredAt;
    stored.operation.result = {
      kind: "recover",
      recovery_id: applied.recovery_id,
      next_state: applied.next_state,
      idle_confirmed: applied.next_state === "recovery_required",
      replayed_shell: false,
    };
    context.host.store.update(stored);
    if (applied.next_state === "recovery_required") {
      reconcileIdleRecovery(context.host, applied.operation_id, applied.job_id, applied.recovery_id, recoveredAt);
    } else if (context.host.lease.isHeld()) {
      const evidence = await acknowledgeOwnedWorker({
        projectCwd: context.project.target_realpath,
        operationId: applied.operation_id,
        jobId: applied.job_id ?? context.job.job_id,
      });
      if (!evidence.cleaned) {
        stored.operation.state = "recovery_required";
        stored.operation.error = {
          code: "recovery_required",
          message: evidence.reason ?? "worker cleanup was not acknowledged",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        context.host.store.update(stored);
        return { dispatch: false, holdLease: true };
      }
      context.host.lease.release(applied.operation_id);
    }
    return { dispatch: false, holdLease: false };
  }

  if (action === "prepare") {
    setWorkspacePhase(basePath, "plan");
    beginPrepareMode(basePath, {
      jobId: context.job.job_id,
      milestoneId,
      operationId: stored.operation.operation_id,
    });
    lastMilestoneLock.set(basePath, milestoneId);
    process.env.GSD_MILESTONE_LOCK = milestoneId;
    const next = nativeOps.dispatchWouldSelect
      ? await nativeOps.dispatchWouldSelect({ basePath, milestoneId })
      : null;
    if (next && isImplementationUnit(next.unitType)) {
      const policy = await evaluateCompulsoryPolicy(basePath, { phase: "plan" });
      const policyPass = policy.kind === "unmanaged" || (policy.kind === "evaluated" && policy.result.verdict === "pass");
      if (!policyPass) {
        stored.operation.state = "failed";
        stored.operation.updated_at = nowIso(context.host.clock);
        stored.operation.error = {
          code: "invalid_contract",
          message: policy.kind === "blocked" ? policy.reason : "Required plan validation did not pass",
          retryable: false,
          operation_id: stored.operation.operation_id,
        };
        context.host.store.update(stored);
        endPrepareMode(basePath);
        return { dispatch: false, holdLease: false };
      }
      stored.operation.state = "succeeded";
      stored.operation.updated_at = nowIso(context.host.clock);
      stored.operation.result = {
        kind: "prepare",
        boundary: "prepared",
        stopped_before: next.unitType,
        unit_id: next.unitId,
        implementation: false,
      };
      context.host.store.update(stored);
      endPrepareMode(basePath);
      return { dispatch: false, holdLease: false };
    }
    const start = nativeOps.startScopedAuto
      ? await nativeOps.startScopedAuto({ basePath, milestoneId, resume: false })
      : await defaultStart({
        basePath,
        milestoneId,
        resume: false,
        onEvent: (event) => recordBridgeEvent(context, event),
      });
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "prepare", milestoneLock: start.milestoneLock, dispatched: true };
    context.host.store.update(stored);
    observeDispatch(context.host, stored.operation.operation_id, start.dispatch);
    return { dispatch: true, holdLease: true };
  }

  if (action === "review") {
    setWorkspacePhase(basePath, "review");
    const publish = nativeOps.publishReviewFindings;
    if (!publish) {
      failOperation(context.host, stored, "runtime_unavailable", "Native review workflow is not registered");
      return { dispatch: false, holdLease: false };
    }
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "review" };
    context.host.store.update(stored);
    const operationId = stored.operation.operation_id;
    void publish({
      basePath,
      milestoneId,
      operationId,
      jobId: context.job.job_id,
      revision: context.job.revision,
    }).then((findings) => {
      const current = context.host.store.read(operationId);
      if (!current || current.operation.state !== "running") return;
      if (findings.executed !== true) {
        settleNativeDispatchFailure(context.host, operationId, new NativeDispatchError("Native review did not publish findings", true));
        return;
      }
      if (findings.productMutated) {
        failOperation(context.host, current, "invalid_contract", "Review cannot mutate product code");
        context.host.lease.release(operationId);
        return;
      }
      current.operation.state = "succeeded";
      current.operation.updated_at = nowIso(context.host.clock);
      current.operation.error = null;
      current.operation.result = { kind: "review", findings: findings.findings, product_mutated: false };
      context.host.store.update(current);
      context.host.lease.release(operationId);
    }).catch((error) => {
      settleNativeDispatchFailure(context.host, operationId, error);
    });
    return { dispatch: true, holdLease: true };
  }

  if (action === "replan") {
    const reason = String(context.request.parameters.reason ?? "");
    const replan = nativeOps.replanMilestone;
    if (!replan) {
      failOperation(context.host, stored, "runtime_unavailable", "Native replan workflow is not registered");
      return { dispatch: false, holdLease: false };
    }
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = { kind: "replan" };
    context.host.store.update(stored);
    const operationId = stored.operation.operation_id;
    void replan({
      basePath,
      milestoneId,
      reason,
      operationId,
      jobId: context.job.job_id,
      revision: context.job.revision,
    }).then((result) => {
      const current = context.host.store.read(operationId);
      if (!current || current.operation.state !== "running") return;
      if (result.preservedCompleted !== true) {
        settleNativeDispatchFailure(context.host, operationId, new NativeDispatchError("native replan did not persist a plan", true));
        return;
      }
      context.host.jobs.bumpRevision(context.job.job_id);
      current.operation.state = "succeeded";
      current.operation.updated_at = nowIso(context.host.clock);
      current.operation.error = null;
      current.operation.result = {
        kind: "replan",
        preserved_completed: result.preservedCompleted,
        evidence_invalidated: result.evidenceInvalidated,
        reason,
      };
      context.host.store.update(current);
      context.host.lease.release(operationId);
    }).catch((error) => {
      settleNativeDispatchFailure(context.host, operationId, error);
    });
    return { dispatch: true, holdLease: true };
  }

  if (action === "start" || action === "resume") {
    setWorkspacePhase(basePath, "implement");
    const start = nativeOps.startScopedAuto
      ? await nativeOps.startScopedAuto({ basePath, milestoneId, resume: action === "resume" })
      : await defaultStart({
        basePath,
        milestoneId,
        resume: action === "resume",
        onEvent: (event) => recordBridgeEvent(context, event),
      });
    lastMilestoneLock.set(basePath, start.milestoneLock);
    stored.operation.state = "running";
    stored.operation.updated_at = nowIso(context.host.clock);
    stored.operation.result = {
      kind: action,
      milestoneLock: start.milestoneLock,
      scoped: true,
    };
    context.host.store.update(stored);
    observeDispatch(context.host, stored.operation.operation_id, start.dispatch);
    return { dispatch: true, holdLease: true };
  }

  return { dispatch: false, holdLease: false };
}

export function issueCrashRecovery(host: CommandHost, operationId: string, jobId: string | null, reason: string) {
  return issueRecoveryId({
    operation_id: operationId,
    job_id: jobId,
    reason,
    issued_at: nowIso(host.clock),
    next_state: "recovery_required",
  });
}
