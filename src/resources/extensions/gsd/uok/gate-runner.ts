import type { FailureClass, GateResult } from "./contracts.js";
import { insertGateRun, isDbAvailable } from "../gsd-db.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";
import { isUnifiedAuditEnabled } from "./audit-toggle.js";
import { logError } from "../workflow-logger.js";

export interface GateRunnerContext {
  basePath: string;
  traceId: string;
  turnId: string;
  milestoneId?: string;
  sliceId?: string;
  taskId?: string;
  unitType?: string;
  unitId?: string;
}

export interface GateExecutionInput {
  id: string;
  type: string;
  execute: (ctx: GateRunnerContext, attempt: number) => Promise<{
    outcome: "pass" | "fail" | "retry" | "manual-attention";
    rationale?: string;
    findings?: string;
    failureClass?: FailureClass;
  }>;
}

const RETRY_MATRIX: Record<FailureClass, number> = {
  none: 0,
  policy: 0,
  input: 0,
  execution: 1,
  artifact: 1,
  verification: 1,
  closeout: 1,
  git: 1,
  timeout: 2,
  "manual-attention": 0,
  // A refusal is deterministic by definition (#2046) — never gate-retry it.
  refusal: 0,
  unknown: 0,
};

function emitGateAuditIfEnabled(ctx: GateRunnerContext, result: GateResult): void {
  if (!isUnifiedAuditEnabled(ctx.basePath)) return;

  emitUokAuditEvent(
    ctx.basePath,
    buildAuditEnvelope({
      traceId: ctx.traceId,
      turnId: ctx.turnId,
      category: "gate",
      type: "gate-run",
      payload: {
        gateId: result.gateId,
        gateType: result.gateType,
        outcome: result.outcome,
        failureClass: result.failureClass,
        attempt: result.attempt,
        maxAttempts: result.maxAttempts,
        retryable: result.retryable,
      },
    }),
  );
}

/**
 * gate_runs and audit rows are telemetry for the gate (coordination tables,
 * not workflow state). With no DB the record is refused and logged as an
 * error, never dropped silently (ADR-046); a failed DB write still throws.
 */
function recordGateResult(ctx: GateRunnerContext, result: GateResult): void {
  if (!isDbAvailable()) {
    logError("db", `gate ${result.gateId} result not recorded: workflow DB is unavailable`);
    return;
  }
  insertGateRun({
    traceId: ctx.traceId,
    turnId: ctx.turnId,
    gateId: result.gateId,
    gateType: result.gateType,
    unitType: ctx.unitType,
    unitId: ctx.unitId,
    milestoneId: ctx.milestoneId,
    sliceId: ctx.sliceId,
    taskId: ctx.taskId,
    outcome: result.outcome,
    failureClass: result.failureClass,
    rationale: result.rationale,
    findings: result.findings,
    attempt: result.attempt,
    maxAttempts: result.maxAttempts,
    retryable: result.retryable,
    evaluatedAt: result.evaluatedAt,
  });
  emitGateAuditIfEnabled(ctx, result);
}

export class UokGateRunner {
  private readonly registry = new Map<string, GateExecutionInput>();

  register(gate: GateExecutionInput): void {
    this.registry.set(gate.id, gate);
  }

  list(): GateExecutionInput[] {
    return Array.from(this.registry.values());
  }

  async run(id: string, ctx: GateRunnerContext): Promise<GateResult> {
    const gate = this.registry.get(id);
    if (!gate) {
      const now = new Date().toISOString();
      const unknownResult: GateResult = {
        gateId: id,
        gateType: "unknown",
        outcome: "manual-attention",
        failureClass: "unknown",
        rationale: `Gate ${id} not registered`,
        attempt: 1,
        maxAttempts: 1,
        retryable: false,
        evaluatedAt: now,
      };

      recordGateResult(ctx, unknownResult);

      return unknownResult;
    }

    let attempt = 0;
    let final: GateResult | null = null;
    const maxAttemptsByFailureClass = RETRY_MATRIX;
    const maxAttemptsCeiling = Math.max(...Object.values(RETRY_MATRIX)) + 1;

    while (attempt < maxAttemptsCeiling) {
      attempt += 1;
      const now = new Date().toISOString();

      let result: {
        outcome: "pass" | "fail" | "retry" | "manual-attention";
        rationale?: string;
        findings?: string;
        failureClass?: FailureClass;
      };

      try {
        result = await gate.execute(ctx, attempt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          outcome: "fail",
          failureClass: "unknown",
          rationale: message,
        };
      }
      const failureClass = result.failureClass ?? (result.outcome === "pass" ? "none" : "unknown");
      const retryBudget = maxAttemptsByFailureClass[failureClass] ?? 0;
      const retryable = result.outcome !== "pass" && attempt <= retryBudget;

      final = {
        gateId: gate.id,
        gateType: gate.type,
        outcome: retryable ? "retry" : result.outcome,
        failureClass,
        rationale: result.rationale,
        findings: result.findings,
        attempt,
        maxAttempts: retryBudget + 1,
        retryable,
        evaluatedAt: now,
      };

      recordGateResult(ctx, final);

      if (!retryable) break;
    }

    return final ?? {
      gateId: gate.id,
      gateType: gate.type,
      outcome: "manual-attention",
      failureClass: "unknown",
      attempt: 1,
      maxAttempts: 1,
      retryable: false,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
