/**
 * Tool-call loop guard.
 *
 * Detects when a model repeats tool calls within a single Agent Turn.
 * Works in both auto-mode and interactive sessions by hooking into the
 * native engine's `tool_call` event, which fires before execution and can
 * block the call.
 *
 * The guard has two independent checks: a sliding window for identical
 * tool signatures, and a per-tool-name cap for repeated calls with varied
 * arguments. State resets at Agent Turn boundaries (session_start,
 * agent_end) and the identical-signature streak also resets when a
 * different tool call breaks the streak. Block messages instruct the model
 * to stop tooling for the rest of that turn and answer in text.
 *
 * The per-tool-name check (#783 Brief C) tracks call counts within a
 * turn regardless of args, decaying after successful state-progressing tools.
 * This catches improvisation
 * loops where the model attempts the same missing workflow tool through
 * varied surfaces (bash → `node -e` → CLI), each with a different
 * signature, so the identical-args streak never trips, while allowing
 * tool-heavy turns that are making progress. Progress means a successful file
 * mutation (edit/write), durable workflow mutation, or shell/exec call
 * (bg_shell, gsd_uat_exec, …) — so legitimate persistence and iterative
 * debugging loops are not blocked as false loops (#1206, #1985). Whichever
 * guard trips first blocks.
 *
 * Thresholds, exempt tools, and enable flags are user-tunable (#1198) via the
 * `tool_call_loop_guard` key in `.gsd/PREFERENCES.md` and `GSD_TOOL_LOOP_*`
 * environment variables, applied through {@link configureToolCallLoopGuard}.
 * Defaults preserve the original hardcoded behavior.
 */

import { createHash } from "node:crypto";
import { INHERENTLY_REPEATABLE_TOOL_SET } from "./core-session-tools.js";
import { hasBrowserContractPrefix } from "../../shared/browser-contract.js";
import { canonicalToolName, canonicalWorkflowToolName } from "../engine-hook-contract.js";

/** Built-in defaults. Preserved when preferences/env do not override them. */
const DEFAULT_MAX_CONSECUTIVE_IDENTICAL_CALLS = 4;
const DEFAULT_PER_TOOL_DEFAULT_CAP = 6;
const DEFAULT_PER_TOOL_REPEATABLE_CAP = 15;

/**
 * Tools exempt from Guard 2 (per-tool-name cap), exported so tests and tooling
 * can inspect the defaults. User-supplied `exempt_tools` are additive to this
 * set.
 *
 * Read-only navigation tools (#1093, #1095) and read-only workflow query tools
 * (#2753) are normal context gathering: a planning turn legitimately looks up
 * many different decisions/requirements, and these tools never record
 * mutations so their counts would never decay. Guard 1's identical-args streak
 * still catches a genuine reread loop of the same ID.
 *
 * The workflow names mirror the pure-lookup members of the contracts'
 * `writePolicy: "read"` set (packages/contracts/src/workflow.ts). Where the
 * pi-native and MCP surfaces spell a tool differently both names are listed
 * (`memory_query`/`gsd_memory_query`, `gsd_graph`/`gsd_memory_graph`).
 * Accepted nuance: `memory_query`/`gsd_memory_query` with `reinforce_hits`
 * bump persistent hit counts — ranking telemetry only, no workflow state, and
 * distinct-arg reinforced queries are legitimate, so they stay exempt (Guard 1
 * still blocks an identical-args hammer). Side-effecting read-policy tools
 * stay capped: `gsd_checkpoint_db` flushes the SQLite WAL.
 */
export const DEFAULT_PER_TOOL_CAP_EXEMPT_TOOLS = [
  // Read-only navigation (#1093, #1095).
  "find",
  "glob",
  "grep",
  "ls",
  "read",
  "search_and_read",
  // Read-only workflow queries (#2753).
  "gsd_decision_get",
  "gsd_decision_list",
  "gsd_requirement_get",
  "gsd_requirement_list",
  "gsd_project_snapshot",
  "gsd_milestone_status",
  "gsd_journal_query",
  "gsd_exec_search",
  "gsd_resume",
  "memory_query",
  "gsd_memory_query",
  "gsd_graph",
  "gsd_memory_graph",
] as const;

/** Interactive/user-facing tools where even 1 duplicate is confusing. */
const STRICT_LOOP_TOOLS = new Set(["ask_user_questions"]);
const MAX_CONSECUTIVE_STRICT = 1;

const STATE_MUTATING_TOOL_SET = new Set(["edit", "write", "multi_edit", "notebook_edit"]);

/**
 * Successful shell/exec calls are state progression too (#1206), not just file
 * mutations. A local model debugging a UAT scenario legitimately restarts
 * servers, runs `npm install`, and curls endpoints via bg_shell / gsd_uat_exec
 * with varied args — productive work that never touches a file, so Guard 2's
 * per-tool cap would otherwise misfire as a false loop. Decaying on these
 * successful calls keeps the guard from aborting a progressing turn.
 *
 * Only successful calls reach {@link recordToolCallLoopMutation}: the
 * tool_result hook skips `isError` results, and the bash tool throws on
 * non-zero exit, so a genuinely stuck improvisation loop of failing commands
 * (#783) never decays and still trips the cap. `async_bash` is excluded
 * because it only registers a background job; command success is reported
 * later via `await_job`. `bg_shell` may return `isError: false` for failed
 * `run`/`start` outcomes, so the hook passes `details` for validation.
 */
const STATE_PROGRESSING_EXEC_TOOL_SET = new Set([
  "bash",
  "bg_shell",
  "shell",
  "powershell",
  "gsd_exec",
  "gsd_uat_exec",
]);

function isSuccessfulBgShellLoopProgress(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const record = details as Record<string, unknown>;
  switch (record.action) {
    case "run":
      return record.exitCode === 0 && record.timedOut !== true;
    case "start":
    case "restart": {
      const process = record.process;
      if (!process || typeof process !== "object") return false;
      return (process as Record<string, unknown>).alive === true;
    }
    case "wait_for_ready":
      return record.ready === true;
    case "send_and_wait":
      return record.matched === true;
    default:
      return true;
  }
}

/**
 * User-tunable configuration shape for the loop guard (#1198).
 *
 * Mirrors the `tool_call_loop_guard` key in `.gsd/PREFERENCES.md`. All fields
 * are optional; anything omitted falls back to the built-in defaults so that
 * existing installs keep their current behavior.
 */
export interface ToolCallLoopGuardConfig {
  enabled?: boolean;
  identical_args?: {
    enabled?: boolean;
    max_consecutive_calls?: number;
  };
  repeated_tool?: {
    enabled?: boolean;
    default_cap?: number;
    repeatable_cap?: number;
    exempt_tools?: string[];
  };
}

/**
 * Active, resolved configuration. Set by {@link configureToolCallLoopGuard}
 * from preferences + environment overrides, and deliberately NOT touched by
 * {@link resetToolCallLoopGuard} so a session's tuning survives turn
 * boundaries.
 */
interface ResolvedGuardConfig {
  /** Master switch for both guards. */
  guardEnabled: boolean;
  identicalEnabled: boolean;
  maxConsecutiveIdentical: number;
  repeatedEnabled: boolean;
  perToolDefaultCap: number;
  perToolRepeatableCap: number;
  /** Tool names exempt from Guard 2 (per-tool-name cap). */
  perToolExempt: Set<string>;
}

function defaultGuardConfig(): ResolvedGuardConfig {
  return {
    guardEnabled: true,
    identicalEnabled: true,
    maxConsecutiveIdentical: DEFAULT_MAX_CONSECUTIVE_IDENTICAL_CALLS,
    repeatedEnabled: true,
    perToolDefaultCap: DEFAULT_PER_TOOL_DEFAULT_CAP,
    perToolRepeatableCap: DEFAULT_PER_TOOL_REPEATABLE_CAP,
    perToolExempt: new Set<string>(DEFAULT_PER_TOOL_CAP_EXEMPT_TOOLS),
  };
}

let config: ResolvedGuardConfig = defaultGuardConfig();

/** Parse a positive-integer env var, returning undefined when unset/invalid. */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/** Parse a boolean env var (`true`/`1` vs `false`/`0`), undefined when unset. */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return undefined;
}

/** Parse a comma-separated tool-name list env var. */
function envToolList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve preferences + environment overrides into the active configuration.
 * Environment variables win over preferences; preferences win over built-in
 * defaults. User-supplied exempt tools are additive to the built-in exempt
 * set so defaults are always preserved.
 *
 * Applied to both interactive sessions and `/gsd auto` (called from the
 * session_start / session_switch hooks).
 */
export function configureToolCallLoopGuard(prefs?: ToolCallLoopGuardConfig | null): void {
  const next = defaultGuardConfig();

  if (prefs) {
    if (typeof prefs.enabled === "boolean") next.guardEnabled = prefs.enabled;
    if (prefs.identical_args) {
      if (typeof prefs.identical_args.enabled === "boolean") next.identicalEnabled = prefs.identical_args.enabled;
      if (typeof prefs.identical_args.max_consecutive_calls === "number" && prefs.identical_args.max_consecutive_calls >= 1) {
        next.maxConsecutiveIdentical = Math.floor(prefs.identical_args.max_consecutive_calls);
      }
    }
    if (prefs.repeated_tool) {
      if (typeof prefs.repeated_tool.enabled === "boolean") next.repeatedEnabled = prefs.repeated_tool.enabled;
      if (typeof prefs.repeated_tool.default_cap === "number" && prefs.repeated_tool.default_cap >= 1) {
        next.perToolDefaultCap = Math.floor(prefs.repeated_tool.default_cap);
      }
      if (typeof prefs.repeated_tool.repeatable_cap === "number" && prefs.repeated_tool.repeatable_cap >= 1) {
        next.perToolRepeatableCap = Math.floor(prefs.repeated_tool.repeatable_cap);
      }
      for (const tool of prefs.repeated_tool.exempt_tools ?? []) {
        if (typeof tool === "string" && tool.trim()) next.perToolExempt.add(tool.trim());
      }
    }
  }

  // Environment overrides (win over preferences).
  const envEnabled = envBool("GSD_TOOL_LOOP_GUARD_ENABLED");
  if (envEnabled !== undefined) next.guardEnabled = envEnabled;
  const envIdenticalMax = envPositiveInt("GSD_TOOL_LOOP_IDENTICAL_MAX");
  if (envIdenticalMax !== undefined) next.maxConsecutiveIdentical = envIdenticalMax;
  const envDefaultCap = envPositiveInt("GSD_TOOL_LOOP_REPEATED_DEFAULT_CAP");
  if (envDefaultCap !== undefined) next.perToolDefaultCap = envDefaultCap;
  const envRepeatableCap = envPositiveInt("GSD_TOOL_LOOP_REPEATED_REPEATABLE_CAP");
  if (envRepeatableCap !== undefined) next.perToolRepeatableCap = envRepeatableCap;
  for (const tool of envToolList("GSD_TOOL_LOOP_EXEMPT_TOOLS")) next.perToolExempt.add(tool);

  config = next;
}

let consecutiveCount = 0;
let lastSignature = "";
let lastToolName = "";
let enabled = true;

/** Per-tool-name call counts within the current turn (#783 Brief C). */
const perToolCounts = new Map<string, number>();
let mutationEpoch = 0;
const perToolLastMutationEpoch = new Map<string, number>();

/** Hash tool name + args into a compact signature for comparison. */
function hashToolCall(toolName: string, args: Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(toolName);
  // Sort keys recursively for deterministic hashing regardless of object key order
  h.update(JSON.stringify(args, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort().reduce<Record<string, unknown>>((o, k) => {
          o[k] = value[k];
          return o;
        }, {})
      : value
  ));
  return h.digest("hex").slice(0, 16);
}

/**
 * Record a tool call and check if it should be blocked.
 *
 * Returns `{ block: false }` for allowed calls.
 * Returns `{ block: true, reason }` when the loop threshold is exceeded.
 *
 * Two independent guards run; whichever trips first blocks:
 *  1. Identical-signature streak (config.maxConsecutiveIdentical, strict for
 *     ask_user_questions).
 *  2. Per-tool-name cap (config.perToolDefaultCap / config.perToolRepeatableCap),
 *     independent of args, reset after successful state progress — catches
 *     improvisation loops (#783).
 *
 * Both guards, their thresholds, and the per-tool exempt set are user-tunable
 * via {@link configureToolCallLoopGuard} (#1198).
 */
export function checkToolCallLoop(
  toolName: string,
  args: Record<string, unknown>,
): { block: boolean; reason?: string; count?: number } {
  if (!enabled || !config.guardEnabled) return { block: false, count: 0 };

  const sig = hashToolCall(toolName, args);

  if (sig === lastSignature) {
    consecutiveCount++;
  } else {
    consecutiveCount = 1;
    lastSignature = sig;
    lastToolName = toolName;
  }

  // ── Guard 1: identical-signature streak ──
  const threshold = STRICT_LOOP_TOOLS.has(toolName)
    ? MAX_CONSECUTIVE_STRICT
    : config.maxConsecutiveIdentical;

  if (config.identicalEnabled && consecutiveCount > threshold) {
    return {
      block: true,
      reason:
        `Tool loop detected (identical args): ${toolName} called ${consecutiveCount} times ` +
        `with identical arguments (max ${threshold}). Blocking to prevent infinite loop. ` +
        `Raise tool_call_loop_guard.identical_args.max_consecutive_calls in .gsd/PREFERENCES.md ` +
        `(or GSD_TOOL_LOOP_IDENTICAL_MAX) if this is expected. ` +
        `Do not retry this tool or call other tools this turn — stop and respond to the user in text.`,
      count: consecutiveCount,
    };
  }

  // ── Guard 2: per-tool-name cap, independent of args (#783 Brief C) ──
  // Catches improvisation loops where the same tool is invoked many times with
  // varied args (e.g. retrying a missing workflow tool via bash/node -e/CLI).
  const priorPerToolCount =
    (perToolLastMutationEpoch.get(toolName) ?? mutationEpoch) < mutationEpoch
      ? 0
      : (perToolCounts.get(toolName) ?? 0);
  const perToolCount = priorPerToolCount + 1;
  perToolCounts.set(toolName, perToolCount);
  perToolLastMutationEpoch.set(toolName, mutationEpoch);

  // Read-only navigation tools are normal context gathering; Guard 1 still
  // catches true reread loops with identical arguments. Read-only workflow DB
  // query tools are the same shape (#2753): a planning turn legitimately looks
  // up many different decisions/requirements, and those lookups never record
  // mutations, so the arg-independent per-tool cap would misfire. Exempt names
  // are matched both exactly (preserving user-configured MCP-prefixed
  // `exempt_tools` entries) and against the canonical (MCP-prefix-stripped)
  // tool name — the way the Browser Automation Contract exemption below works —
  // so MCP-surfaced variants (mcp__<server>__gsd_decision_get, …) are covered
  // too. Browser Automation Contract tools (browser_*) are likewise a
  // distinct-arg-heavy, read-mostly surface (#1120).
  const canonicalName = canonicalToolName(toolName);
  if (
    !config.repeatedEnabled ||
    config.perToolExempt.has(toolName) ||
    config.perToolExempt.has(canonicalName) ||
    hasBrowserContractPrefix(canonicalName)
  ) {
    return { block: false, count: consecutiveCount };
  }

  const perToolCap = INHERENTLY_REPEATABLE_TOOL_SET.has(toolName)
    ? config.perToolRepeatableCap
    : config.perToolDefaultCap;

  if (perToolCount > perToolCap) {
    return {
      block: true,
      reason:
        `Tool loop detected (repeated tool): ${toolName} called ${perToolCount} times ` +
        `this turn (cap ${perToolCap}). Blocking to prevent infinite loop. ` +
        `The tool may be unavailable or failing repeatedly. ` +
        `Raise tool_call_loop_guard.repeated_tool.default_cap/repeatable_cap or add "${toolName}" ` +
        `to tool_call_loop_guard.repeated_tool.exempt_tools in .gsd/PREFERENCES.md ` +
        `(or GSD_TOOL_LOOP_REPEATED_* / GSD_TOOL_LOOP_EXEMPT_TOOLS) if this is expected. ` +
        `Do not retry this tool or pivot to other tools this turn — stop and respond to the user in text.`,
      count: perToolCount,
    };
  }

  return { block: false, count: consecutiveCount };
}

/**
 * Record successful state progress so Guard 2 can decay on the next count.
 * File mutations (edit/write/…), durable workflow mutations, and successful
 * shell/exec calls (bash, bg_shell, gsd_uat_exec, …) count as progress (#1092,
 * #1206, #1985). Failed results never decay, including workflow tools that
 * report failure through `details.error` instead of the event error flag.
 */
export function recordToolCallLoopMutation(toolName: string, details?: unknown): void {
  if (!enabled) return;
  if (STATE_MUTATING_TOOL_SET.has(toolName)) {
    mutationEpoch++;
    return;
  }
  if (STATE_PROGRESSING_EXEC_TOOL_SET.has(toolName)) {
    if (toolName === "bg_shell" && details !== undefined && !isSuccessfulBgShellLoopProgress(details)) return;
    mutationEpoch++;
    return;
  }
  if (canonicalWorkflowToolName(toolName) !== "gsd_requirement_save") return;
  if (!details || typeof details !== "object") return;
  const result = details as Record<string, unknown>;
  if (result.operation !== "save_requirement") return;
  const id = result.id;
  if (typeof id !== "string" || id.length === 0) return;
  mutationEpoch++;
}

/** Reset the guard state. Call at agent turn boundaries. */
export function resetToolCallLoopGuard(): void {
  consecutiveCount = 0;
  lastSignature = "";
  lastToolName = "";
  enabled = true;
  perToolCounts.clear();
  mutationEpoch = 0;
  perToolLastMutationEpoch.clear();
}

/** Disable the guard (e.g. during shutdown). */
export function disableToolCallLoopGuard(): void {
  enabled = false;
  consecutiveCount = 0;
  lastSignature = "";
  lastToolName = "";
  perToolCounts.clear();
  mutationEpoch = 0;
  perToolLastMutationEpoch.clear();
}

/** Get current consecutive count for diagnostics. */
export function getToolCallLoopCount(): number {
  return consecutiveCount;
}

/**
 * Get the per-tool-name call count for the current turn (#783 Brief C).
 * Returns 0 for tools not yet called. Diagnostic only.
 */
export function getToolCallCountForTool(toolName: string): number {
  return perToolCounts.get(toolName) ?? 0;
}
