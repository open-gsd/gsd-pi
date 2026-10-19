// Project/App: gsd-pi
// File Purpose: Typed workflow commands for host transports (RPC
// `workflow_command`). A host mutates workflow state through the same
// executors as the workflow tools, with its own idempotency key and expected
// project revision, and not by sending slash-command text.

import type { WorkflowCommandResult } from "@opengsd/contracts";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { appendCapture } from "./captures.js";
import { rpcExecutionInvocation, type ExecutionInvocation } from "./execution-invocation.js";
import { getProjectAuthorityVersion } from "./gsd-db.js";
import { registerSteerOverride } from "./overrides.js";
import type { ToolExecutionResult } from "./tools/context-mode-tool-result.js";
import {
  executeMilestoneDiscard,
  executeMilestonePark,
  executeMilestoneReorder,
  executeMilestoneSetDependencies,
  executeMilestoneUnpark,
} from "./tools/milestone-hierarchy.js";

type CommandArgs = Record<string, unknown>;

function text(args: CommandArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Workflow command requires args.${key}`);
  return value;
}

function ids(args: CommandArgs, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`Workflow command requires args.${key} as a list of milestone ids`);
  }
  return value;
}

/**
 * Run the Domain Operation of a slash command that has no workflow tool. The
 * action returns the success text. A refused operation gives an error result
 * with the reason, like a tool executor.
 */
async function runOperatorCommand(cwd: string, action: () => string | Promise<string>): Promise<ToolExecutionResult> {
  try {
    if (!(await ensureDbOpen(cwd))) throw new Error("GSD database is not available.");
    return { content: [{ type: "text", text: await action() }], details: {} };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: message }, isError: true };
  }
}

const COMMANDS: Readonly<Record<
  string,
  (args: CommandArgs, cwd: string, invocation: ExecutionInvocation) => Promise<ToolExecutionResult>
>> = {
  milestone_park: (args, cwd, invocation) =>
    executeMilestonePark({ milestoneId: text(args, "milestoneId"), reason: text(args, "reason") }, cwd, invocation),
  milestone_unpark: (args, cwd, invocation) =>
    executeMilestoneUnpark({ milestoneId: text(args, "milestoneId") }, cwd, invocation),
  milestone_discard: (args, cwd, invocation) =>
    executeMilestoneDiscard({ milestoneId: text(args, "milestoneId"), reason: text(args, "reason") }, cwd, invocation),
  milestone_reorder: (args, cwd, invocation) =>
    executeMilestoneReorder({ order: ids(args, "order") }, cwd, invocation),
  milestone_set_dependencies: (args, cwd, invocation) =>
    executeMilestoneSetDependencies(
      { milestoneId: text(args, "milestoneId"), dependsOn: ids(args, "dependsOn") },
      cwd,
      invocation,
    ),
  // `/gsd capture`: the capture waits for triage like any other.
  capture_register: (args, cwd, invocation) => {
    const captureText = text(args, "text");
    return runOperatorCommand(cwd, () => `Captured: ${appendCapture(cwd, captureText, invocation)}`);
  },
  // `/gsd steer`: the override is in every later unit prompt, and auto-mode
  // runs a rewrite-docs unit before the next task. The command sends no
  // message to the agent; the host does that.
  override_register: (args, cwd, invocation) => {
    const change = text(args, "change");
    return runOperatorCommand(cwd, async () => {
      await registerSteerOverride(cwd, change, invocation);
      return `Override registered: ${change}`;
    });
  },
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
