/**
 * Content-free provenance in native sessions. These observations are not
 * workflow authority or a live worker registry.
 */
export const GSD_WORKFLOW_CONTEXT = "gsd-workflow-context";
export const GSD_DELEGATION_CONTEXT = "gsd-delegation-context";
export const GSD_AUTO_MODE = "gsd-auto";

export interface GsdWorkflowContext {
  originSessionId: string;
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
}

export interface GsdDelegationContext {
  originSessionId: string;
  id: string;
  mode: "single" | "parallel" | "chain";
  count: number;
  forkCount: number;
  background: boolean;
  status: "requested" | "settled";
  successCount?: number;
  failureCount?: number;
}

interface MetadataWriter {
  appendEntry?(type: string, data: unknown): void;
}

/** Record an Auto-mode start without creating an assistant turn or storing prompt text. */
export function recordAutoMode(pi: MetadataWriter): void {
  try { pi.appendEntry?.(GSD_AUTO_MODE, { version: 1 }); }
  catch { /* Optional mode metadata must never block Auto. */ }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validOrigin(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function readWorkflowContext(value: unknown): GsdWorkflowContext | undefined {
  const data = object(value);
  if (!data || data.version !== 1 || !validOrigin(data.originSessionId) || typeof data.milestoneId !== "string"
    || !/^M\d{3}(?:-[a-z0-9]{6})?$/.test(data.milestoneId)) return undefined;
  if (data.sliceId !== undefined && (typeof data.sliceId !== "string" || !/^S\d{2,6}$/.test(data.sliceId))) return undefined;
  if (data.taskId !== undefined && (typeof data.taskId !== "string" || !/^T\d{2,6}$/.test(data.taskId) || !data.sliceId)) return undefined;
  return {
    originSessionId: data.originSessionId,
    milestoneId: data.milestoneId,
    ...(typeof data.sliceId === "string" ? { sliceId: data.sliceId } : {}),
    ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
  };
}

export function readDelegationContext(value: unknown): GsdDelegationContext | undefined {
  const data = object(value);
  if (!data || data.version !== 1 || !validOrigin(data.originSessionId) || typeof data.id !== "string"
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.id)
    || !["single", "parallel", "chain"].includes(data.mode as string)
    || !Number.isSafeInteger(data.count) || (data.count as number) < 1 || (data.count as number) > 1024
    || !Number.isSafeInteger(data.forkCount) || (data.forkCount as number) < 0 || (data.forkCount as number) > (data.count as number)
    || typeof data.background !== "boolean" || !["requested", "settled"].includes(data.status as string)) return undefined;
  const result: GsdDelegationContext = {
    originSessionId: data.originSessionId,
    id: data.id, mode: data.mode as GsdDelegationContext["mode"],
    count: data.count as number, forkCount: data.forkCount as number,
    background: data.background, status: data.status as GsdDelegationContext["status"],
  };
  if (result.status === "settled") {
    if (!Number.isSafeInteger(data.successCount) || (data.successCount as number) < 0
      || !Number.isSafeInteger(data.failureCount) || (data.failureCount as number) < 0
      || (data.successCount as number) + (data.failureCount as number) > result.count) return undefined;
    result.successCount = data.successCount as number;
    result.failureCount = data.failureCount as number;
  }
  return result;
}

export function recordWorkflowContext(pi: MetadataWriter, getSessionId: () => string, unitId: string): void {
  try {
    const [milestoneId, sliceId, taskId, extra] = unitId.split("/");
    if (extra !== undefined) return;
    const context = readWorkflowContext({ version: 1, originSessionId: getSessionId(), milestoneId, sliceId, taskId });
    if (context) pi.appendEntry?.(GSD_WORKFLOW_CONTEXT, { version: 1, ...context });
  } catch { /* Optional provenance must not affect dispatch. */ }
}

/** A late background completion must never append to a different conversation. */
export function recordDelegation(
  pi: MetadataWriter,
  getSessionId: () => string,
  context: Omit<GsdDelegationContext, "originSessionId" | "status" | "successCount" | "failureCount">,
): (successCount: number, failureCount: number) => void {
  let owner: string | undefined;
  try { owner = getSessionId(); } catch { /* Stale runtime. */ }
  const append = (status: "requested" | "settled", successCount?: number, failureCount?: number) => {
    try {
      if (!owner || getSessionId() !== owner) return;
      const data = readDelegationContext({ version: 1, ...context, originSessionId: owner, status, successCount, failureCount });
      if (data) pi.appendEntry?.(GSD_DELEGATION_CONTEXT, { version: 1, ...data });
    } catch { /* Optional provenance must not affect workers. */ }
  };
  append("requested");
  return (successCount, failureCount) => append("settled", successCount, failureCount);
}
