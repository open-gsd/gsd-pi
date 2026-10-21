// Project/App: gsd-pi
// File Purpose: Private transport identity carried into Task execution Domain Operations.

export interface ExecutionInvocation {
  idempotencyKey: string;
  sourceTransport: "internal" | "pi-tool" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}

export function piExecutionInvocation(
  canonicalToolName: string,
  toolCallId: string,
): ExecutionInvocation {
  return {
    idempotencyKey: `pi:${canonicalToolName}:${toolCallId}`,
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: toolCallId,
  };
}

export function internalExecutionInvocation(
  idempotencyKey: string,
  identity: Pick<ExecutionInvocation, "actorId" | "traceId" | "turnId"> = {},
): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    ...identity,
  };
}
