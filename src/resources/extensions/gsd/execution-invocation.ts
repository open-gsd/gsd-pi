// Project/App: gsd-pi
// File Purpose: Private transport identity carried into Task execution Domain Operations.

export interface ExecutionInvocation {
  idempotencyKey: string;
  sourceTransport: "internal" | "pi-tool" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
  /**
   * The project revision the caller last read. When set, the Domain Operation
   * is refused if the project changed since then. Without it the operation
   * expects the revision at the time it runs.
   */
  expectedRevision?: number;
}

/**
 * A typed workflow command from a host (RPC `workflow_command`). It has the
 * provenance of the slash command it replaces: the operator acts, inside the
 * process. The key prefix names the RPC channel.
 */
export function rpcExecutionInvocation(
  commandName: string,
  idempotencyKey: string,
  expectedRevision?: number,
): ExecutionInvocation {
  return {
    idempotencyKey: `rpc:${commandName}:${idempotencyKey}`,
    sourceTransport: "internal",
    actorType: "operator",
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
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
