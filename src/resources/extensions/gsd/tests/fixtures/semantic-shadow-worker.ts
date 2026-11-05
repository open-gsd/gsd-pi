// Project/App: gsd-pi
// File Purpose: Deterministic real-process worker for semantic-shadow soak tests.

import { existsSync, writeFileSync } from "node:fs";

import { _setDomainOperationFaultForTest, type DomainOperationFaultPoint } from "../../db/domain-operation.ts";
import { closeDatabase, openDatabase } from "../../gsd-db.ts";
import {
  beginMilestoneStatusObservationTurn,
  clearMilestoneStatusObservationTurn,
} from "../../milestone-status-observation-context.ts";
import {
  _setLifecycleShadowRepairBeforeCommitForTest,
  repairLifecycleShadowForward,
} from "../../lifecycle-shadow-repair-domain-operation.ts";

interface BarrierPaths {
  ready?: string;
  release?: string;
}

interface StatusReadInput extends BarrierPaths {
  action: "status-read";
  databasePath: string;
  basePath: string;
  milestoneId: string;
}

interface RepairInput extends BarrierPaths {
  action: "repair";
  databasePath: string;
  idempotencyKey: string;
  taskId: string;
  faultPoint?: DomainOperationFaultPoint;
  committed?: string;
  closeRelease?: string;
}

interface TokenHoldInput extends BarrierPaths {
  action: "token-hold";
  basePath: string;
  tokenPath: string;
  token: string;
  mode: "auto" | "interactive" | "guided" | "uok" | "custom" | "legacy";
  traceId: string;
  turnId: string;
  clearOnExit?: boolean;
  now?: number;
  ttlMs?: number;
}

type WorkerInput = StatusReadInput | RepairInput | TokenHoldInput;
type StatusReadInterleaveSetter = (hook: (() => void) | null) => void;

interface WorkerError {
  code: string;
  message: string;
}

interface WorkerOutcome {
  action: WorkerInput["action"];
  pid: number;
  result?: unknown;
  error?: WorkerError;
}

function waitForFile(path: string): void {
  const deadline = Date.now() + 30_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for barrier: ${path}`);
    Atomics.wait(waiter, 0, 0, 5);
  }
}

function reachBarrier(paths: BarrierPaths): void {
  if (paths.ready) writeFileSync(paths.ready, String(process.pid), "utf8");
  if (paths.release) waitForFile(paths.release);
}

async function runStatusRead(input: StatusReadInput): Promise<unknown> {
  if (!openDatabase(input.databasePath)) throw new Error("status worker could not open database");
  let setInterleave: StatusReadInterleaveSetter | undefined;
  try {
    const workflowExecutors = await import("../../tools/workflow-tool-executors.ts");
    setInterleave = (
      workflowExecutors as typeof workflowExecutors & {
        _setMilestoneStatusReadInterleaveForTest?: StatusReadInterleaveSetter;
      }
    )._setMilestoneStatusReadInterleaveForTest;
    if (!setInterleave) throw new Error("milestone status read interleave hook is unavailable");
    setInterleave(() => reachBarrier(input));
    return await workflowExecutors.executeMilestoneStatus(
      { milestoneId: input.milestoneId },
      input.basePath,
      {
        mode: "legacy",
        transport: "workflow_mcp",
        sourceRevision: "semantic-shadow-soak",
        traceId: `trace/status/${process.pid}`,
        turnId: `turn/status/${process.pid}`,
      },
    );
  } finally {
    setInterleave?.(null);
    closeDatabase();
  }
}

function runRepair(input: RepairInput): unknown {
  if (!openDatabase(input.databasePath)) throw new Error("repair worker could not open database");
  _setLifecycleShadowRepairBeforeCommitForTest(() => reachBarrier(input));
  if (input.faultPoint) _setDomainOperationFaultForTest(input.faultPoint);
  try {
    const receipt = repairLifecycleShadowForward({
      invocation: {
        idempotencyKey: input.idempotencyKey,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "semantic-shadow-soak-worker",
        traceId: `trace/${input.idempotencyKey}`,
        turnId: `turn/${input.idempotencyKey}`,
      },
      item: {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: input.taskId,
      },
    });
    if (input.committed) writeFileSync(input.committed, String(process.pid), "utf8");
    if (input.closeRelease) waitForFile(input.closeRelease);
    return receipt;
  } finally {
    _setDomainOperationFaultForTest(null);
    _setLifecycleShadowRepairBeforeCommitForTest(null);
    closeDatabase();
  }
}

function runTokenHold(input: TokenHoldInput): unknown {
  const token = beginMilestoneStatusObservationTurn(
    input.basePath,
    {
      mode: input.mode,
      sourceRevision: `source/${input.token}`,
      traceId: input.traceId,
      turnId: input.turnId,
    },
    {
      token: input.token,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    },
  );
  if (token === null) throw new Error("token worker could not persist observation context");
  writeFileSync(input.tokenPath, token, "utf8");
  if (input.ready) writeFileSync(input.ready, String(process.pid), "utf8");
  if (input.release) waitForFile(input.release);
  const cleared = input.clearOnExit ? clearMilestoneStatusObservationTurn(input.basePath, token) : false;
  return { token, cleared };
}

async function main(): Promise<void> {
  const encoded = process.argv.at(-1);
  if (!encoded) throw new Error("semantic shadow worker requires one JSON input");
  const input = JSON.parse(encoded) as WorkerInput;
  const outcome: WorkerOutcome = { action: input.action, pid: process.pid };
  try {
    if (input.action === "status-read") outcome.result = await runStatusRead(input);
    else if (input.action === "repair") outcome.result = runRepair(input);
    else outcome.result = runTokenHold(input);
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    outcome.error = {
      code: String(candidate.code ?? "UNKNOWN"),
      message: String(candidate.message ?? error),
    };
  }
  process.stdout.write(`SEMANTIC_SHADOW_OUTCOME=${JSON.stringify(outcome)}\n`);
}

await main();
