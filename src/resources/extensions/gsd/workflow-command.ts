// Project/App: gsd-pi
// File Purpose: Typed workflow commands for host transports (RPC
// `workflow_command`). A host mutates workflow state through the same
// executors as the workflow tools, with its own idempotency key and expected
// project revision, and not by sending slash-command text.

import type { WorkflowCommandResult } from "@opengsd/contracts";
import { rpcExecutionInvocation, type ExecutionInvocation } from "./execution-invocation.js";
import { getProjectAuthorityVersion } from "./gsd-db.js";
import type { ToolExecutionResult } from "./tools/context-mode-tool-result.js";
import { executeMilestonePark, executeMilestoneUnpark } from "./tools/milestone-hierarchy.js";

type CommandArgs = Record<string, unknown>;

function text(args: CommandArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Workflow command requires args.${key}`);
  return value;
}

const COMMANDS: Readonly<Record<
  string,
  (args: CommandArgs, cwd: string, invocation: ExecutionInvocation) => Promise<ToolExecutionResult>
>> = {
  milestone_park: (args, cwd, invocation) =>
    executeMilestonePark({ milestoneId: text(args, "milestoneId"), reason: text(args, "reason") }, cwd, invocation),
  milestone_unpark: (args, cwd, invocation) =>
    executeMilestoneUnpark({ milestoneId: text(args, "milestoneId") }, cwd, invocation),
};

/**
 * Run one typed workflow command. `input` is the RPC command plus the session
 * CWD. A malformed command throws. A command that the Domain Operation refuses
 * (unknown milestone, stale revision) returns `ok: false` with the reason.
 */
export async function runWorkflowCommand(input: unknown): Promise<WorkflowCommandResult> {
  const { cwd, name, args, idempotencyKey, expectedRevision } = (input ?? {}) as CommandArgs;
  if (typeof cwd !== "string") throw new Error("Workflow command requires a session CWD");
  const execute = typeof name === "string" && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!execute) throw new Error(`Unknown workflow command: ${String(name)}`);
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new Error("Workflow command requires an idempotencyKey");
  }
  if (expectedRevision !== undefined && !Number.isSafeInteger(expectedRevision)) {
    throw new Error("Workflow command expectedRevision must be an integer");
  }
  if (!args || typeof args !== "object") throw new Error("Workflow command requires args");

  const result = await execute(
    args as CommandArgs,
    cwd,
    rpcExecutionInvocation(name as string, idempotencyKey, expectedRevision as number | undefined),
  );
  return {
    ok: result.isError !== true,
    message: result.content[0].text,
    revision: getProjectAuthorityVersion().revision,
  };
}
