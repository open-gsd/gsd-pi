// gsd-pi - Write gate state (database rows) and policy guards.
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { minimatch } from "minimatch";

import { GSD_PHASE_SCOPE_DISPLAY_REASON, shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.js";
import { canonicalToolName } from "../engine-hook-contract.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "../preferences.js";
import { compileSubagentPermissionContract, type ToolsPolicy } from "../unit-context-manifest.js";
import {
  allowedPlanningDispatchAgentsList,
  isReadOnlyPlanningDispatchAgent,
} from "../planning-subagent-registry.js";
import { logWarning } from "../workflow-logger.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "../worktree-root.js";
import { worktreesDirs } from "../worktree-placement.js";
import { bashReferencesProjectRootOutsideWorktree } from "../worktree-shell-guard.js";
import { evaluateGateAnswer } from "../consent-verdict.js";
import { getWorkflowDatabasePath, openExistingWorkflowDatabase, resolveProjectRootDbPath } from "../db-workspace.js";
import { isDbAvailable } from "../db/engine.js";
import { normalizeRealPath } from "../paths.js";
import { listWriteGateRows, updateWriteGateRows, type WriteGateRow } from "../db/writers/write-gate.js";

/**
 * Regex matching milestone CONTEXT.md file names in both legacy M001
 * and unique M001-abc123 formats. Exported so regex-hardening tests
 * can exercise the real pattern rather than a drift-prone inline
 * re-implementation (see #4835).
 */
export const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;
const CONTEXT_MILESTONE_RE = /(?:^|[/\\])(M\d+(?:-[a-z0-9]{6})?)-CONTEXT\.md$/i;
const DEPTH_VERIFICATION_MILESTONE_RE = /depth_verification[_-](M\d+(?:-[a-z0-9]{6})?)/i;

function normalizeMilestoneId(milestoneId: string): string {
  const match = milestoneId.match(/^(M)(\d+)(?:-([a-z0-9]{6}))?$/i);
  if (!match) return milestoneId;
  return `M${match[2]}${match[3] ? `-${match[3].toLowerCase()}` : ""}`;
}

/**
 * Path segment that identifies .gsd/ planning artifacts.
 * Writes to these paths are allowed during queue mode.
 */
const GSD_DIR_RE = /(^|[/\\])\.gsd([/\\]|$)/;

/**
 * Read-only tool names that are always safe during queue mode.
 */
const QUEUE_SAFE_TOOLS = new Set([
  "read", "grep", "find", "ls", "glob",
  // Discussion & planning tools
  "ask_user_questions",
  "gsd_milestone_generate_id",
  "gsd_milestone_set_dependencies",
  "gsd_summary_save",
  "gsd_requirement_save",
  "gsd_requirement_update",
  "gsd_decision_save",
  // Web research tools used during queue discussion
  "search-the-web", "resolve_library", "get_library_docs", "fetch_page",
  "search_and_read",
]);

/**
 * Bash commands that are read-only / investigative — safe during queue mode.
 * Matches the leading command in a bash invocation.
 *
 * Extension policy: add commands here when they are read-only / diagnostic.
 * Never add commands that mutate project state (write files, run builds that
 * emit artifacts, install packages, etc.).
 *
 * Current read-only additions (Bug #4385):
 *   npm run <diagnostic> — read-only diagnostic scripts: test, lint, typecheck, etc.
 *                         NOT: build, install, compile, generate, deploy (artifact-producing)
 *   npm ls/list/info    — inspect installed packages (read-only)
 *   npm outdated/audit  — security/update checks (read-only)
 *   npx <pkg>           — run a package binary without installing globally
 *   tsx                 — TypeScript runner used for dry-run / inspection scripts
 *   node --print        — evaluate and print an expression, no side effects
 *   python / python3    — script inspection, version checks
 *   pip / pip3 show     — show installed package info (read-only)
 *   jq                  — read-only JSON query
 *   yq                  — read-only YAML query
 *   curl -s / curl --silent — fetch for inspection (no -o / no output redirect)
 *   openssl version     — version / certificate inspection
 *   env / printenv      — print environment variables
 *   true / false        — shell no-ops / test exit codes
 */
const BASH_READ_ONLY_RE = /^\s*((?:cd|pushd|popd)(?:\s|$)|cat|head|tail|less|more|wc|file|stat|du|df|which|type|echo|printf|ls|find|grep|rg|awk|sed\b(?!.*-i)|sort|uniq|diff|comm|tr|cut|tee\s+-a\s+\/dev\/null|git\s+(log|show|diff|status|branch|tag|remote|rev-parse|ls-files|blame|shortlog|describe|stash\s+list|config\s+--get|cat-file)|gh\s+(issue|pr|api|repo|release)\s+(view|list|diff|status|checks)|mkdir\s+-p\s+\.gsd|rtk\s|npm\s+run\s+(test|test:\w+|lint|lint:\w+|typecheck|type-check|type-check:\w+|check|verify|audit|outdated|format:check|ci|validate)\b|npm\s+(ls|list|info|view|show|outdated|audit|explain|doctor|ping|--version|-v)\b|npx\s|tsx\s|node\s+(--print|--version|-v\b)|python[23]?\s+(-c\s+'[^']*'|--version|-V\b|-m\s+(pip\s+show|pip\s+list|site))|pip[23]?\s+(show|list|freeze|check|index\s+versions)\b|jq\s|yq\s|curl\s+(-s\b|--silent\b)(?!\s+[^|>]*\s-[oO]\b)(?!\s+[^|>]*\s--output\b)[^|>]*$|openssl\s+(version|x509|s_client)|env\b|printenv\b|true\b|false\b)/;
const BASH_VERIFICATION_RE = /^\s*(npm\s+(run\s+(build|test|test:\w+|lint|lint:\w+|typecheck|type-check|verify|ci|validate)\b|test\b)|pnpm\s+(build|test|lint|typecheck|verify)\b|yarn\s+(build|test|lint|typecheck|verify)\b|vitest\b|jest\b|go\s+test\b)/;

interface WriteGateState {
  verifiedDepthMilestones: Set<string>;
  verifiedApprovalGates: Set<string>;
  activeQueuePhase: boolean;
  pendingGateId: string | null;
  /** Why the project database could not be opened; the gate then fails closed. */
  storeError: string | null;
}

function createEmptyWriteGateState(): WriteGateState {
  return {
    verifiedDepthMilestones: new Set<string>(),
    verifiedApprovalGates: new Set<string>(),
    activeQueuePhase: false,
    pendingGateId: null,
    storeError: null,
  };
}

/**
 * Gate state of a project that has no workflow database at all: no `.gsd`, or
 * no gsd.db yet. It keeps an armed gate blocking inside this process until the
 * database exists; the first gate call after that moves it into the rows. A
 * project that has a database never uses it. Keyed by project root so
 * workspaces in one process stay apart.
 */
const memoryWriteGateStates = new Map<string, WriteGateState>();

function memoryWriteGateKey(basePath: string): string {
  return normalizeRealPath(resolveWorktreeProjectRoot(basePath));
}

function memoryWriteGateState(basePath: string): WriteGateState {
  const key = memoryWriteGateKey(basePath);
  let state = memoryWriteGateStates.get(key);
  if (!state) {
    state = createEmptyWriteGateState();
    memoryWriteGateStates.set(key, state);
  }
  return state;
}

/**
 * Recognized gate question ID patterns.
 * These appear in discuss.md (depth/requirements/roadmap).
 */
const GATE_QUESTION_PATTERNS = [
  "depth_verification",
] as const;

/**
 * Tools that are safe to call while a gate is pending.
 * Only ask_user_questions may run: once the assistant asks for confirmation,
 * further reads/searches bury the actual question in tool output.
 */
const GATE_SAFE_TOOLS = new Set([
  "ask_user_questions",
]);

/**
 * Which process wrote a gate row: the extension host ("host") or the workflow
 * MCP child ("child"), which dynamically imports this same compiled module in
 * its own process.
 */
export type WriteGateWriter = "host" | "child";

export interface WriteGateSnapshot {
  verifiedDepthMilestones: string[];
  verifiedApprovalGates?: string[];
  activeQueuePhase: boolean;
  pendingGateId: string | null;
  /** Set when the project database exists but could not be opened: every gated write is blocked. */
  storeError?: string;
}

/**
 * Where the gate state of a project is: the rows of its open database
 * ("rows"), process memory because the project has no database ("memory"), or
 * nowhere readable, with the reason as the value.
 */
type WriteGateStore = "rows" | "memory" | { storeError: string };

/**
 * Open the gate state of a project. Gate state is project-scoped: a worktree
 * resolves to the project database.
 *
 * A gate call can run before anything opened the database (the workflow MCP
 * child before its first tool) or after it was closed (the host after
 * `/gsd stop`), so the existing project database is opened here. A database is
 * never created here. A database that exists and does not open is not treated
 * as "no gate": the caller fails closed.
 */
function openWriteGateStore(basePath: string): WriteGateStore {
  const openPath = isDbAvailable() ? getWorkflowDatabasePath() : null;
  if (openPath === null || normalizeRealPath(openPath) !== normalizeRealPath(resolveProjectRootDbPath(basePath))) {
    const opened = openExistingWorkflowDatabase(basePath);
    if (!opened.ok) {
      if (opened.reason === "missing-gsd-dir" || opened.reason === "missing-database") return "memory";
      const detail = opened.error ? `${opened.reason}: ${opened.error.message}` : opened.reason;
      return {
        storeError: `Write-gate state is unavailable: the project database ${opened.location.projectDb} could not be opened (${detail}).`,
      };
    }
  }
  adoptMemoryWriteGateState(basePath);
  return "rows";
}

/** Move gate state that was armed before the project had a database into its rows. */
function adoptMemoryWriteGateState(basePath: string): void {
  const key = memoryWriteGateKey(basePath);
  const memory = memoryWriteGateStates.get(key);
  if (!memory) return;
  const memoryRows = rowsFromState(memory);
  if (memoryRows.length > 0) {
    updateWriteGateRows(defaultWriteGateWriter(), (rows) => rowsFromState(stateFromRows([...rows, ...memoryRows])));
  }
  memoryWriteGateStates.delete(key);
}

function stateFromRows(rows: readonly WriteGateRow[]): WriteGateState {
  const state = createEmptyWriteGateState();
  for (const row of rows) {
    if (row.gate_kind === "depth_verified") state.verifiedDepthMilestones.add(row.gate_id);
    else if (row.gate_kind === "approval_verified") state.verifiedApprovalGates.add(row.gate_id);
    else if (row.gate_kind === "pending") state.pendingGateId = row.gate_id;
    else state.activeQueuePhase = true;
  }
  return state;
}

function rowsFromState(state: WriteGateState): WriteGateRow[] {
  const rows: WriteGateRow[] = [];
  for (const gate_id of state.verifiedDepthMilestones) rows.push({ gate_kind: "depth_verified", gate_id });
  for (const gate_id of state.verifiedApprovalGates) rows.push({ gate_kind: "approval_verified", gate_id });
  if (state.pendingGateId) rows.push({ gate_kind: "pending", gate_id: state.pendingGateId });
  if (state.activeQueuePhase) rows.push({ gate_kind: "queue_phase", gate_id: "active" });
  return rows;
}

function readWriteGateState(basePath: string): WriteGateState {
  const store = openWriteGateStore(basePath);
  if (store === "rows") return stateFromRows(listWriteGateRows());
  if (store === "memory") return memoryWriteGateStates.get(memoryWriteGateKey(basePath)) ?? createEmptyWriteGateState();
  return { ...createEmptyWriteGateState(), storeError: store.storeError };
}

/**
 * The one reader of gate state. The extension host and the workflow MCP child
 * both read the write_gate_state rows of the project database through it, so
 * neither process holds a copy that can go stale.
 */
export function loadWriteGateSnapshot(basePath: string): WriteGateSnapshot {
  const state = readWriteGateState(basePath);
  return {
    verifiedDepthMilestones: [...state.verifiedDepthMilestones].sort(),
    verifiedApprovalGates: [...state.verifiedApprovalGates].sort(),
    activeQueuePhase: state.activeQueuePhase,
    pendingGateId: state.pendingGateId,
    ...(state.storeError ? { storeError: state.storeError } : {}),
  };
}

/** What the user sees when a gated write is refused because the gate state cannot be read. */
const WRITE_GATE_STORE_ERROR_DISPLAY_REASON = "The project database could not be opened.";

/** A gate verdict. `displayReason` is set when the user-facing label is not the caller's default. */
export interface WriteGateVerdict {
  block: boolean;
  reason?: string;
  displayReason?: string;
}

/**
 * The block for a gate state that cannot be read. It applies to the gated
 * writes only (milestone CONTEXT, PROJECT, REQUIREMENTS and requirement
 * writes): an approval cannot be confirmed, so they fail closed. Every other
 * tool stays usable, so the user can work and repair the database.
 */
function storeErrorBlock(snapshot: WriteGateSnapshot): WriteGateVerdict | null {
  if (!snapshot.storeError) return null;
  return {
    block: true,
    reason: [
      `HARD BLOCK: ${snapshot.storeError}`,
      `This write needs the user's recorded approval, and the approval cannot be read or recorded until the database opens.`,
      `This is a database problem, not a question that waits for an answer: do NOT ask the user to confirm again.`,
      `Tell the user to repair the database: the error above names the command when there is one`,
      `(a checkout-unbound error: /gsd db bind; a schema-too-new error: upgrade GSD); otherwise run /gsd doctor. Then retry this write.`,
    ].join(" "),
    displayReason: WRITE_GATE_STORE_ERROR_DISPLAY_REASON,
  };
}

/** A verified gate is not pending: drop the pending gate that `state` already verifies. */
function dropVerifiedPendingGate(state: WriteGateState): void {
  if (state.pendingGateId && isGateVerified(state, state.pendingGateId)) state.pendingGateId = null;
}

function isGateVerified(state: WriteGateState, gateId: string): boolean {
  const milestoneId = extractDepthVerificationMilestoneId(gateId);
  return state.verifiedApprovalGates.has(gateId) ||
    (milestoneId !== null && state.verifiedDepthMilestones.has(milestoneId));
}

/**
 * Read-modify-write primitive for gate mutations. With a database the read,
 * the mutation and the write are one SQLite write transaction, so the host and
 * the workflow MCP child cannot overwrite each other. A database that does not
 * open records nothing: the change is logged and this function returns false.
 *
 * The mutate callback sees the stored state, so policy checks (the host's
 * verified-wins guard in setPending) live inside it. Returning `false` from
 * the callback aborts: nothing is written and this function returns false.
 */
function mutateWriteGateState(
  basePath: string,
  writer: WriteGateWriter,
  mutate: (state: WriteGateState) => void | false,
): boolean {
  const apply = (state: WriteGateState): boolean => {
    if (mutate(state) === false) return false;
    dropVerifiedPendingGate(state);
    return true;
  };
  const store = openWriteGateStore(basePath);
  if (store === "memory") return apply(memoryWriteGateState(basePath));
  if (store !== "rows") {
    logWarning("intercept", `write-gate change by the ${writer} was not recorded. ${store.storeError}`);
    return false;
  }
  return updateWriteGateRows(writer, (rows) => {
    const state = stateFromRows(rows);
    return apply(state) ? rowsFromState(state) : null;
  });
}

export function isDepthVerified(basePath: string = process.cwd()): boolean {
  return readWriteGateState(basePath).verifiedDepthMilestones.size > 0;
}

/**
 * Check whether a specific milestone has passed depth verification.
 */
export function isMilestoneDepthVerified(
  milestoneId: string | null | undefined,
  basePath: string = process.cwd(),
): boolean {
  if (!milestoneId) return false;
  return readWriteGateState(basePath).verifiedDepthMilestones.has(normalizeMilestoneId(milestoneId));
}

export function isMilestoneDepthVerifiedInSnapshot(
  snapshot: WriteGateSnapshot,
  milestoneId: string | null | undefined,
): boolean {
  if (!milestoneId) return false;
  return snapshot.verifiedDepthMilestones.includes(normalizeMilestoneId(milestoneId));
}

export function isQueuePhaseActive(basePath: string = process.cwd()): boolean {
  return readWriteGateState(basePath).activeQueuePhase;
}

export function setQueuePhaseActive(active: boolean, basePath: string): void {
  mutateWriteGateState(basePath, defaultWriteGateWriter(), (state) => {
    state.activeQueuePhase = active;
  });
}

/**
 * End of a discussion flow (the discuss→auto handoff): remove every gate row
 * of the project. The CONTEXT save consumed the depth verification; a later
 * discussion of the same milestone must ask again.
 */
export function clearDiscussionFlowState(basePath: string): void {
  mutateWriteGateState(basePath, defaultWriteGateWriter(), (state) => {
    state.verifiedDepthMilestones.clear();
    state.verifiedApprovalGates.clear();
    state.activeQueuePhase = false;
    state.pendingGateId = null;
  });
}

/**
 * Apply a session boundary of the extension host to gate state.
 *
 * The conversation that asked a pending gate question, and the /gsd queue
 * conversation, are gone at every boundary, so the pending gate is cleared and
 * the queue phase ends. A verified gate is a database row and survives a
 * restart ("start") and a resume: the CONTEXT save it allows may still be
 * outstanding. `/clear` and `/new` ("new") abandon the discussion, so they
 * remove every gate row, like the discuss→auto handoff.
 */
export function applyWriteGateSessionBoundary(
  boundary: "start" | "resume" | "new",
  basePath: string,
): void {
  if (boundary === "new") {
    clearDiscussionFlowState(basePath);
    return;
  }
  mutateWriteGateState(basePath, "host", (state) => {
    state.pendingGateId = null;
    state.activeQueuePhase = false;
  });
}

/**
 * Ambient (env-sniffed) export, reserved for the child's dynamic-import
 * surface (packages/mcp-server) and module-internal use. Host-owned modules
 * (register-hooks, auto-dispatch, …) must call
 * hostWriteGateAdapter.markDepthVerified explicitly so a leaked
 * GSD_WORKFLOW_* env variable cannot silently flip them to child semantics.
 */
export function markDepthVerified(milestoneId?: string | null, basePath: string = process.cwd()): void {
  defaultWriteGateAdapter().markDepthVerified(milestoneId, basePath);
}

/** Ambient export for the child's dynamic-import surface — see markDepthVerified. */
export function markApprovalGateVerified(gateId?: string | null, basePath: string = process.cwd()): void {
  defaultWriteGateAdapter().markApprovalGateVerified(gateId, basePath);
}

export function isApprovalGateVerifiedInSnapshot(
  snapshot: WriteGateSnapshot,
  gateId?: string | null,
): boolean {
  if (!gateId) return false;
  return (snapshot.verifiedApprovalGates ?? []).includes(gateId);
}

/**
 * Check whether a question ID matches a recognized gate pattern.
 */
export function isGateQuestionId(questionId: string): boolean {
  return GATE_QUESTION_PATTERNS.some(pattern => questionId.includes(pattern));
}

/**
 * Extract the milestone ID embedded in a depth-verification question id.
 * Prompts are expected to use ids like `depth_verification_M001_confirm`.
 */
export function extractDepthVerificationMilestoneId(questionId: string): string | null {
  const match = questionId.match(DEPTH_VERIFICATION_MILESTONE_RE);
  return match?.[1] ? normalizeMilestoneId(match[1]) : null;
}

/**
 * Extract the milestone ID from a milestone CONTEXT file path.
 */
function extractContextMilestoneId(inputPath: string): string | null {
  const match = inputPath.match(CONTEXT_MILESTONE_RE);
  return match?.[1] ? normalizeMilestoneId(match[1]) : null;
}

/**
 * Mark a gate as pending (called when ask_user_questions is invoked with a
 * gate ID). Delegates to the process's default adapter: in the workflow MCP
 * child the arm is unconditional (a fresh question intentionally revokes
 * prior verification); in the host a gate that is already verified is not
 * armed and the call returns false.
 *
 * Ambient (env-sniffed) export, reserved for the child's dynamic-import
 * surface (packages/mcp-server). Host-owned modules must call
 * hostWriteGateAdapter.setPending explicitly.
 */
export function setPendingGate(gateId: string, basePath: string): boolean {
  return defaultWriteGateAdapter().setPending(gateId, basePath);
}

/**
 * Clear the pending gate (called when the user confirms).
 * Ambient export for the child's dynamic-import surface — host-owned
 * modules must call hostWriteGateAdapter.clearPending explicitly.
 */
export function clearPendingGate(basePath: string): void {
  defaultWriteGateAdapter().clearPending(basePath);
}

/** Get the currently pending gate, if any. */
export function getPendingGate(basePath: string = process.cwd()): string | null {
  return readWriteGateState(basePath).pendingGateId;
}

// ─── Write-gate writers ──────────────────────────────────────────────────────
//
// Two processes write the gate rows: the extension host and the workflow MCP
// child (which dynamically imports this same compiled module — see
// GSD_WORKFLOW_WRITE_GATE_MODULE in workflow-mcp.ts and
// packages/mcp-server/src/server.ts). They share the rows and the reader. They
// differ only in the setPending policy below.

export interface WriteGateStateAdapter {
  readonly writer: WriteGateWriter;
  markDepthVerified(milestoneId: string | null | undefined, basePath: string): void;
  markApprovalGateVerified(gateId: string | null | undefined, basePath: string): void;
  /**
   * Arm a pending gate. Returns false when the adapter's policy suppressed
   * the arm (host: the gate is already verified — verified wins over a stale
   * re-arm). Child adapter always arms (a fresh question intentionally
   * revokes prior verification).
   */
  setPending(gateId: string, basePath: string): boolean;
  clearPending(basePath: string): void;
}

function createWriteGateAdapter(writer: WriteGateWriter): WriteGateStateAdapter {
  return {
    writer,
    markDepthVerified(milestoneId, basePath): void {
      if (!milestoneId) return;
      mutateWriteGateState(basePath, writer, (state) => {
        state.verifiedDepthMilestones.add(normalizeMilestoneId(milestoneId));
      });
    },
    markApprovalGateVerified(gateId, basePath): void {
      if (!gateId) return;
      mutateWriteGateState(basePath, writer, (state) => {
        state.verifiedApprovalGates.add(gateId);
      });
    },
    setPending(gateId: string, basePath: string): boolean {
      return mutateWriteGateState(basePath, writer, (state) => {
        // The host arms from hooks that can run after the child recorded the
        // answer to the same question. Arming then would block every tool for
        // a gate that nothing will verify again.
        if (writer === "host" && isGateVerified(state, gateId)) return false;
        state.pendingGateId = gateId;
        state.verifiedApprovalGates.delete(gateId);
        const milestoneId = extractDepthVerificationMilestoneId(gateId);
        if (milestoneId) state.verifiedDepthMilestones.delete(milestoneId);
      });
    },
    clearPending(basePath: string): void {
      mutateWriteGateState(basePath, writer, (state) => {
        state.pendingGateId = null;
      });
    },
  };
}

/** HOST writer: a gate that is already verified is not armed again. */
export const hostWriteGateAdapter: WriteGateStateAdapter = createWriteGateAdapter("host");

/** CHILD writer: arming is unconditional and revokes the gate's verification. */
export const childWriteGateAdapter: WriteGateStateAdapter = createWriteGateAdapter("child");

/**
 * Which adapter the module-level convenience exports (markDepthVerified,
 * setPendingGate, …) delegate to. The workflow MCP child is spawned with
 * GSD_WORKFLOW_WRITE_GATE_MODULE / GSD_WORKFLOW_PROJECT_ROOT in its
 * environment (workflow-mcp.ts), so when this module is dynamically imported
 * inside that process the child adapter is selected automatically; the
 * extension host process has neither variable and stays on the host adapter.
 */
export function defaultWriteGateWriter(env: NodeJS.ProcessEnv = process.env): WriteGateWriter {
  return env.GSD_WORKFLOW_WRITE_GATE_MODULE || env.GSD_WORKFLOW_PROJECT_ROOT ? "child" : "host";
}

function defaultWriteGateAdapter(): WriteGateStateAdapter {
  return defaultWriteGateWriter() === "child" ? childWriteGateAdapter : hostWriteGateAdapter;
}

/**
 * Check whether a tool call should be blocked because a discussion gate
 * is pending (ask_user_questions was called but not confirmed).
 *
 * Returns { block: true, reason } if the tool should be blocked.
 * ask_user_questions itself is allowed so the model can re-ask the gate.
 */
export function shouldBlockPendingGate(
  toolName: string,
  milestoneId: string | null,
  queuePhaseActive?: boolean,
  basePath: string = process.cwd(),
): { block: boolean; reason?: string } {
  return shouldBlockPendingGateInSnapshot(loadWriteGateSnapshot(basePath), toolName, milestoneId, queuePhaseActive);
}

export function shouldBlockPendingGateInSnapshot(
  snapshot: WriteGateSnapshot,
  toolName: string,
  _milestoneId: string | null,
  _queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  if (!snapshot.pendingGateId) return { block: false };

  if (GATE_SAFE_TOOLS.has(canonicalToolName(toolName))) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
      `The assistant already asked for user confirmation, so do not call more tools.`,
      `Wait for the user's answer, or re-call ask_user_questions with the gate question if the question was not delivered.`,
      `If the previous ask_user_questions call failed, errored, was cancelled, or the user's response`,
      `did not match a provided option, you MUST re-ask — never rationalize past the block.`,
      `Do NOT proceed, do NOT use alternative approaches, do NOT skip the gate.`,
    ].join(" "),
  };
}

/**
 * Check whether a bash command should be blocked because a discussion gate is pending.
 * All bash is blocked while waiting for confirmation so the question stays visible.
 */
export function shouldBlockPendingGateBash(
  command: string,
  milestoneId: string | null,
  queuePhaseActive?: boolean,
  basePath: string = process.cwd(),
): { block: boolean; reason?: string } {
  return shouldBlockPendingGateBashInSnapshot(loadWriteGateSnapshot(basePath), command, milestoneId, queuePhaseActive);
}

export function shouldBlockPendingGateBashInSnapshot(
  snapshot: WriteGateSnapshot,
  command: string,
  _milestoneId: string | null,
  _queuePhaseActive?: boolean,
): { block: boolean; reason?: string } {
  if (!snapshot.pendingGateId) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
      `The assistant already asked for user confirmation, so do not run bash commands.`,
      `Wait for the user's answer, or re-call ask_user_questions with the gate question if the question was not delivered.`,
      `If the previous ask_user_questions call failed, errored, was cancelled, or the user's response`,
      `did not match a provided option, you MUST re-ask — never rationalize past the block.`,
    ].join(" "),
  };
}

// The structural depth-confirmation validator lives in the consent-verdict
// leaf (../consent-verdict.ts) so the write gate and the Consent Question
// module share one verdict engine without an import cycle. Re-exported here
// because the workflow MCP child loads this module by dist path and validates
// the function is present (packages/mcp-server/src/server.ts).
export { isDepthConfirmationAnswer } from "../consent-verdict.js";

export interface AskUserQuestionsGateQuestion {
  id?: unknown;
  options?: Array<{ label?: string }>;
}

export interface AskUserQuestionsGateDetails {
  cancelled?: boolean;
  interrupted?: boolean;
  /**
   * True when the host elicitation channel timed out before the user answered.
   * Distinct from `cancelled` (deliberate dismissal): the gate verdict maps
   * this to "timeout" so callers pause-and-wait instead of letting the model
   * re-ask into the same timeout loop (#852).
   */
  timed_out?: boolean;
  response?: {
    answers?: Record<string, { selected?: unknown } | undefined>;
  } | null;
}

export type AskUserQuestionsGateResult =
  | { status: "not-gate" }
  | { status: "waiting"; pendingGateId: string; interrupted: boolean }
  | { status: "verified"; gateId: string; milestoneId: string | null }
  | { status: "declined"; gateId: string }
  | { status: "timeout"; pendingGateId: string; interrupted: boolean };

function findGateQuestion(
  questions: AskUserQuestionsGateQuestion[],
  gateId: string,
): AskUserQuestionsGateQuestion | undefined {
  return questions.find((question) => question?.id === gateId);
}

function verifyAnsweredGate(
  basePath: string,
  question: AskUserQuestionsGateQuestion,
  fallbackMilestoneId?: string | null,
): AskUserQuestionsGateResult {
  const gateId = typeof question.id === "string" ? question.id : "";
  const milestoneId = extractDepthVerificationMilestoneId(gateId) ?? fallbackMilestoneId ?? null;
  markApprovalGateVerified(gateId, basePath);
  markDepthVerified(milestoneId, basePath);
  clearPendingGate(basePath);
  return { status: "verified", gateId, milestoneId };
}

/**
 * An explicit decline is the latest answer to a gate question. It revokes a
 * verification that an earlier answer gave and leaves the gate pending. The
 * host needs this because a verified row survives a session boundary and the
 * host does not arm a verified gate when the question is asked again.
 */
function revokeDeclinedGate(basePath: string, gateId: string, fallbackMilestoneId?: string | null): void {
  const milestoneId = extractDepthVerificationMilestoneId(gateId) ?? fallbackMilestoneId;
  mutateWriteGateState(basePath, defaultWriteGateWriter(), (state) => {
    state.pendingGateId = gateId;
    state.verifiedApprovalGates.delete(gateId);
    if (milestoneId) state.verifiedDepthMilestones.delete(normalizeMilestoneId(milestoneId));
  });
}

/** Map an unresolved (non-verified) gate verdict to the caller-facing result. */
function unresolvedGateResult(
  verdict: "declined" | "waiting" | "cancelled" | "timeout",
  gateId: string,
  details: AskUserQuestionsGateDetails,
): AskUserQuestionsGateResult {
  if (verdict === "declined") return { status: "declined", gateId };
  if (verdict === "timeout") {
    // Host elicitation expired before the user answered. The gate stays
    // pending (fail-closed — a timeout is never approval), but the status is
    // "timeout" so the caller pauses-and-waits instead of re-asking into the
    // same timeout loop (#852).
    return {
      status: "timeout",
      pendingGateId: gateId,
      interrupted: details.interrupted === true,
    };
  }
  // "waiting" (and the unreachable post-cancel case): an empty selection is
  // not an answer — keep the gate pending and make the caller pause.
  return {
    status: "waiting",
    pendingGateId: gateId,
    interrupted: details.interrupted === true,
  };
}

/**
 * Apply an ask_user_questions round to durable gate state. The per-question
 * VERDICT comes from the consent-verdict leaf (evaluateGateAnswer) — the same
 * engine the Consent Question module uses — so write-gate only owns the
 * persistence/arming side effects:
 *
 * - "verified" verdict → markApprovalGateVerified/markDepthVerified/clearPendingGate.
 * - "declined" verdict → an armed gate stays pending; a gate that is not armed
 *   loses its verification and becomes pending (revokeDeclinedGate).
 * - "waiting" verdict (empty/missing selection) → no state change; reported as
 *   "waiting" so callers pause instead of proceeding (fail-closed; an empty
 *   answer is never an answer).
 */
export function applyAskUserQuestionsGateResult(options: {
  basePath: string;
  questions: AskUserQuestionsGateQuestion[];
  details: AskUserQuestionsGateDetails;
  fallbackMilestoneId?: string | null;
}): AskUserQuestionsGateResult {
  const { basePath, questions, details, fallbackMilestoneId } = options;
  const currentPendingGate = getPendingGate(basePath);
  if (currentPendingGate) {
    if (details.timed_out) {
      // Host elicitation timed out before the user answered. Keep the gate
      // pending (fail-closed) but report "timeout" so the caller pauses-and-
      // waits instead of re-asking into the same timeout loop (#852).
      return {
        status: "timeout",
        pendingGateId: currentPendingGate,
        interrupted: details.interrupted === true,
      };
    }
    if (details.cancelled || !details.response) {
      return {
        status: "waiting",
        pendingGateId: currentPendingGate,
        interrupted: details.interrupted === true,
      };
    }

    const pendingQuestion = findGateQuestion(questions, currentPendingGate);
    if (pendingQuestion) {
      const verdict = evaluateGateAnswer(pendingQuestion, details);
      if (verdict === "verified") {
        return verifyAnsweredGate(basePath, pendingQuestion, fallbackMilestoneId);
      }
      return unresolvedGateResult(verdict, currentPendingGate, details);
    }
  }

  if (details.timed_out) return { status: "not-gate" };
  if (details.cancelled || !details.response) return { status: "not-gate" };

  for (const question of questions) {
    if (typeof question.id !== "string" || !isGateQuestionId(question.id)) continue;
    const verdict = evaluateGateAnswer(question, details);
    if (verdict !== "verified") {
      if (verdict === "declined") revokeDeclinedGate(basePath, question.id, fallbackMilestoneId);
      return unresolvedGateResult(verdict, question.id, details);
    }
    if (currentPendingGate && question.id !== currentPendingGate) {
      // A different gate than the armed one was confirmed — the armed gate is
      // still unresolved, so do not verify and let discussion continue.
      return { status: "declined", gateId: currentPendingGate };
    }
    return verifyAnsweredGate(basePath, question, fallbackMilestoneId);
  }

  return { status: "not-gate" };
}

export function formatPendingAskUserQuestionsGateMessage(
  pendingGateId: string,
  interrupted: boolean,
): string {
  return [
    `Waiting for depth confirmation on gate "${pendingGateId}".`,
    interrupted
      ? "The confirmation question was interrupted before a response was recorded."
      : "No user response was received for the confirmation question.",
    "Do not infer approval from earlier or prior messages.",
    "Do not proceed, write files, save artifacts, or call other tools.",
    `Re-call ask_user_questions with the same gate question id ("${pendingGateId}") and wait for the user's response.`,
  ].join(" ");
}

/**
 * Format the LLM-facing message returned when a depth-confirmation gate
 * elicitation times out. Distinct from {@link formatPendingAskUserQuestionsGateMessage}:
 * a timeout must NOT tell the model to immediately re-ask (that re-triggers
 * the same timeout loop). Instead it tells the model to stop, that auto-mode
 * is paused, and that the user will respond on their own (#852).
 */
export function formatTimedOutAskUserQuestionsGateMessage(
  pendingGateId: string,
): string {
  return [
    `Depth confirmation on gate "${pendingGateId}" timed out waiting for a response.`,
    "The user did not answer within the host elicitation window — do not re-ask in this turn, it will time out again.",
    "Auto-mode is paused. Stop calling tools and wait for the user to respond on a new turn.",
    "When the user replies with confirmation, the gate will be satisfied and work will resume.",
  ].join(" ");
}

export function shouldBlockContextWrite(
  toolName: string,
  inputPath: string,
  milestoneId: string | null,
  _queuePhaseActive?: boolean,
  basePath: string = process.cwd(),
): WriteGateVerdict {
  if (toolName !== "write") return { block: false };
  if (!MILESTONE_CONTEXT_RE.test(inputPath)) return { block: false };

  const targetMilestoneId = extractContextMilestoneId(inputPath) ?? (milestoneId ? normalizeMilestoneId(milestoneId) : null);
  if (!targetMilestoneId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot write milestone CONTEXT.md without knowing which milestone it belongs to.`,
        `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
        `Required action: call ask_user_questions with question id containing "depth_verification" and the milestone id.`,
      ].join(" "),
    };
  }

  const snapshot = loadWriteGateSnapshot(basePath);
  const storeBlock = storeErrorBlock(snapshot);
  if (storeBlock) return storeBlock;
  if (isMilestoneDepthVerifiedInSnapshot(snapshot, targetMilestoneId)) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Cannot write to milestone CONTEXT.md without depth verification.`,
      `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
      `Required action: call ask_user_questions with question id "depth_verification_${targetMilestoneId}_confirm".`,
      `The user MUST select the first "(Recommended)" confirmation option to unlock this gate.`,
      `If the user declines, cancels, or the tool fails, you must re-ask — not bypass.`,
    ].join(" "),
  };
}

/**
 * Check whether a gsd_summary_save CONTEXT artifact should be blocked.
 * Slice-level CONTEXT artifacts are allowed; milestone-level CONTEXT writes
 * require the milestone to be depth-verified first.
 */
export function shouldBlockContextArtifactSave(
  artifactType: string,
  milestoneId: string | null,
  sliceId?: string | null,
  basePath: string = process.cwd(),
): WriteGateVerdict {
  return shouldBlockContextArtifactSaveInSnapshot(loadWriteGateSnapshot(basePath), artifactType, milestoneId, sliceId);
}

export function shouldBlockContextArtifactSaveInSnapshot(
  snapshot: WriteGateSnapshot,
  artifactType: string,
  milestoneId: string | null,
  sliceId?: string | null,
): WriteGateVerdict {
  if (artifactType !== "CONTEXT") return { block: false };
  if (sliceId) return { block: false };
  if (!milestoneId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot save milestone CONTEXT without a milestone_id.`,
        `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
      ].join(" "),
    };
  }
  const storeBlock = storeErrorBlock(snapshot);
  if (storeBlock) return storeBlock;
  if (isMilestoneDepthVerifiedInSnapshot(snapshot, milestoneId)) return { block: false };

  return {
    block: true,
    reason: [
      `HARD BLOCK: Cannot save milestone CONTEXT without depth verification for ${milestoneId}.`,
      `This is a mechanical gate — you MUST NOT proceed, retry, or rationalize past this block.`,
      `Required action: call ask_user_questions with question id containing "depth_verification_${milestoneId}".`,
      `The user MUST select the "(Recommended)" confirmation option to unlock this gate.`,
    ].join(" "),
  };
}

const FINAL_ROOT_ARTIFACTS = new Set(["PROJECT", "REQUIREMENTS"]);

function requiredRootApprovalGateForArtifact(artifactType: string): string | null {
  if (artifactType === "PROJECT") return "depth_verification_project_confirm";
  if (artifactType === "REQUIREMENTS") return "depth_verification_requirements_confirm";
  return null;
}

/**
 * Final root project artifacts are the output of the project/requirements
 * approval gates. Drafts remain writable so the agent can prepare previews,
 * but PROJECT.md and REQUIREMENTS.md must wait for explicit approval. Deep
 * mode can additionally require a positive verified gate, not just no pending
 * gate, so missed detectors fail closed.
 */
export function shouldBlockRootArtifactSaveInSnapshot(
  snapshot: WriteGateSnapshot,
  artifactType: string,
  opts: { requireVerifiedApproval?: boolean } = {},
): WriteGateVerdict {
  if (!FINAL_ROOT_ARTIFACTS.has(artifactType)) return { block: false };

  const storeBlock = storeErrorBlock(snapshot);
  if (storeBlock) return storeBlock;

  if (snapshot.pendingGateId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot save ${artifactType}.md because discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
        `This is a mechanical gate — wait for explicit user approval before writing final project setup artifacts.`,
        `If approval was requested in plain text, the user must reply with explicit approval before this write is allowed.`,
      ].join(" "),
    };
  }

  if (opts.requireVerifiedApproval) {
    const requiredGate = requiredRootApprovalGateForArtifact(artifactType);
    if (requiredGate && !isApprovalGateVerifiedInSnapshot(snapshot, requiredGate)) {
      return {
        block: true,
        reason: [
          `HARD BLOCK: Cannot save ${artifactType}.md before explicit approval gate "${requiredGate}" is verified.`,
          `Deep planning root artifacts are fail-closed: absence of a pending gate is not approval.`,
          `Ask the user to confirm the ${artifactType}.md preview and wait for an explicit approval response.`,
        ].join(" "),
      };
    }
  }

  return { block: false };
}

/**
 * Queue-mode execution guard (#2545).
 *
 * When the queue phase is active, the agent should only create planning
 * artifacts (milestones, CONTEXT.md, QUEUE.md, etc.) — never execute work.
 * This function blocks write/edit/bash tool calls that would modify source
 * code outside of .gsd/.
 *
 * @param toolName  The tool being called (write, edit, bash, etc.)
 * @param input     For write/edit: the file path. For bash: the command string.
 * @param queuePhaseActive  Whether the queue phase is currently active.
 * @returns { block, reason } — block=true if the call should be rejected.
 */
export function shouldBlockQueueExecution(
  toolName: string,
  input: string,
  queuePhaseActive: boolean,
): { block: boolean; reason?: string } {
  // The caller supplies the queue phase, so no gate state is read here.
  return shouldBlockQueueExecutionInSnapshot(
    { verifiedDepthMilestones: [], activeQueuePhase: queuePhaseActive, pendingGateId: null },
    toolName,
    input,
    queuePhaseActive,
  );
}

export function shouldBlockQueueExecutionInSnapshot(
  snapshot: WriteGateSnapshot,
  toolName: string,
  input: string,
  queuePhaseActive: boolean = snapshot.activeQueuePhase,
): { block: boolean; reason?: string } {
  if (!queuePhaseActive) return { block: false };

  // Always-safe tools (read-only, discussion, planning)
  if (QUEUE_SAFE_TOOLS.has(toolName)) return { block: false };

  // write/edit — allow if targeting .gsd/ planning artifacts
  if (toolName === "write" || toolName === "edit") {
    if (GSD_DIR_RE.test(input)) return { block: false };
    return {
      block: true,
      reason: `Blocked: /gsd queue is a planning tool — it creates milestones, not executes work. ` +
        `Cannot ${toolName} to "${input}" during queue mode. ` +
        `Save milestone context and project changes with gsd_summary_save instead.`,
    };
  }

  // bash — allow read-only/investigative commands, block everything else
  if (toolName === "bash") {
    if (BASH_READ_ONLY_RE.test(input)) return { block: false };
    return {
      block: true,
      reason: `Blocked: /gsd queue is a planning tool — it creates milestones, not executes work. ` +
        `Cannot run "${input.slice(0, 80)}${input.length > 80 ? "…" : ""}" during queue mode. ` +
        `Use read-only commands (cat, grep, git log, etc.) to investigate, then write planning artifacts.`,
    };
  }

  // Unknown tools — block by default in queue mode so custom tools cannot
  // bypass execution restrictions.
  return {
    block: true,
    reason: `Blocked: /gsd queue is a planning tool — it creates milestones, not executes work. Unknown tools are not permitted during queue mode.`,
  };
}

// ─── Planning-unit tools-policy enforcement (#4934) ───────────────────────
//
// Runtime half of the declarative ToolsPolicy on UnitContextManifest. The
// manifest assigns each unit type a tools mode; this predicate is what
// actually rejects a tool call that violates it.
//
// Forensics: a discuss-milestone LLM turn used the host Edit tool to modify
// index.html in test app b23 (~/Github/test-apps/b23). With this predicate
// wired into the tool_call hook, the same call returns block=true with a
// HARD BLOCK reason that the model cannot rationalize past.
//
// Activation: the hook supplies the policy resolved from the active unit's
// manifest. When no unit is active (interactive sessions, unknown unit
// types), the hook passes null and this predicate is a no-op — falling
// through to the existing pendingGate / queue-execution / context-write
// guards.

const PLANNING_WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "notebook_edit"]);
const PLANNING_SUBAGENT_TOOLS = new Set(["subagent", "task"]);

export { ALLOWED_PLANNING_DISPATCH_AGENTS } from "../planning-subagent-registry.js";

let warnedMissingControlledDispatchAgentClasses = false;

function allowsControlledSubagentDispatch(
  policy: ToolsPolicy,
): policy is ToolsPolicy & { readonly allowedSubagents: readonly string[] } {
  return (
    (policy.mode === "planning-dispatch" || policy.mode === "verification" || policy.mode === "workflow-only") &&
    Array.isArray((policy as { readonly allowedSubagents?: unknown }).allowedSubagents)
  );
}

function warnMissingControlledDispatchAgentClasses(unitType: string, mode: string, toolName: string): void {
  if (warnedMissingControlledDispatchAgentClasses) return;
  warnedMissingControlledDispatchAgentClasses = true;
  // TODO(#5060): Remove this migration shim once all subagent/task callers are verified to forward agent identities.
  const message = `[write-gate] controlled-dispatch: shouldBlockPlanningUnit called for tool "${toolName}" ` +
    `on unit "${unitType}" without agentClasses - stale caller; blocking dispatch.`;
  console.warn(message);
  logWarning("intercept", message, {
    unitType,
    mode,
    toolName,
  });
}

/**
 * Read-only / planning-safe tools that any non-"all" mode allows. Mirrors
 * QUEUE_SAFE_TOOLS / GATE_SAFE_TOOLS but is the inclusive default for
 * planning units (which need their full discussion + research surface).
 *
 * gsd_* MCP tools are passed through unconditionally — they have their own
 * domain validation (e.g. depth-verification gate, single-writer DB).
 */
const PLANNING_SAFE_TOOLS = new Set([
  "read", "grep", "find", "ls", "glob",
  "ask_user_questions",
  "memory_query",
  "search-the-web", "resolve_library", "get_library_docs", "fetch_page",
  "search_and_read",
]);

function isPathUnderGsd(absPath: string, basePath: string): boolean {
  const localGsdRoot = resolve(basePath, ".gsd");
  const localRel = relative(localGsdRoot, absPath);
  if (localRel === "" || (!localRel.startsWith("..") && !isAbsolute(localRel))) return true;

  const projectRoot = resolveWorktreeProjectRoot(basePath);
  if (projectRoot === basePath) return false;

  const canonicalGsdRoot = resolve(projectRoot, ".gsd");
  const canonicalRel = relative(canonicalGsdRoot, absPath);
  return canonicalRel === "" || (!canonicalRel.startsWith("..") && !isAbsolute(canonicalRel));
}

function matchesAllowedGlob(absPath: string, basePath: string, globs: readonly string[]): boolean {
  const rel = relative(basePath, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // Normalize Windows separators for minimatch.
  const posix = rel.split(sep).join("/");
  return globs.some(g => minimatch(posix, g, { dot: false, nocase: false }));
}

function blockReason(unitType: string, mode: string, what: string): string {
  return [
    `HARD BLOCK: unit "${unitType}" runs under tools-policy "${mode}" — ${what}.`,
    `This is a mechanical gate enforced by manifest.tools. You MUST NOT proceed,`,
    `retry the same call, or rationalize past this block. If you need to write user source,`,
    `the work belongs in execute-task, not in a planning unit.`,
  ].join(" ");
}

function planningBlock(unitType: string, mode: string, what: string): PlanningUnitBlockResult {
  return {
    block: true,
    reason: blockReason(unitType, mode, what),
    displayReason: GSD_PHASE_SCOPE_DISPLAY_REASON,
  };
}

type PlanningUnitBlockResult = {
  block: boolean;
  reason?: string;
  displayReason?: string;
};

/**
 * Planning-unit tool-policy enforcement. Returns { block } per the policy
 * resolved from the active unit's manifest:
 *
 *   - "all"        → never blocks.
 *   - "read-only"  → blocks all writes, bash, and subagent dispatch.
 *   - "planning"   → blocks writes to paths outside <basePath>/.gsd/,
 *                    bash that isn't read-only, and subagent dispatch.
 *   - "planning-dispatch"
 *                  → like "planning", but permits subagent dispatch only
 *                    when every forwarded agent class is globally allowed
 *                    and listed in the policy's allowedSubagents.
 *   - "docs"       → like "planning" but also allows writes to paths
 *                    matching `allowedPathGlobs` relative to basePath.
 *   - "verification"
 *                  → allows Bash for project verification commands, keeps
 *                    writes restricted to .gsd/, and permits subagent dispatch
 *                    only when the manifest declares allowedSubagents.
 *   - "workflow-only"
 *                  → allows reads, GSD workflow tools, and declared read-only
 *                    subagents; blocks generic Bash and direct file writes.
 *
 * `pathOrCommand` is the file path for write/edit-shaped tools and the
 * shell command for bash. Other tools ignore this argument.
 *
 * `policy` of null means "no manifest resolved" — pass-through. Callers
 * that have no active unit (interactive sessions) pass null and this
 * predicate is a no-op.
 *
 * `agentClasses` is supplied by the tool hook for subagent-shaped calls. If
 * absent, planning-dispatch fails closed so stale callers cannot silently
 * bypass the agent allowlists. An explicitly supplied-but-empty list is
 * allowed through so the downstream tool call can reject the malformed input.
 */
export function shouldBlockPlanningUnit(
  toolName: string,
  pathOrCommand: string,
  basePath: string,
  unitType: string,
  policy: ToolsPolicy | null | undefined,
  agentClasses?: readonly string[],
  toolInput?: unknown,
  unitId?: string,
): PlanningUnitBlockResult {
  const tool = canonicalToolName(toolName);
  const autoScopeGuard = shouldBlockAutoUnitToolCall(unitType, toolName, toolInput, unitId);
  if (autoScopeGuard.block) return autoScopeGuard;

  if (!policy) return { block: false };
  if (policy.mode === "all") return { block: false };

  // Read-only mode: only Read-class tools are permitted.
  if (policy.mode === "read-only") {
    if (PLANNING_SAFE_TOOLS.has(tool)) return { block: false };
    if (tool.startsWith("gsd_")) return { block: false };
    if (PLANNING_WRITE_TOOLS.has(tool) || tool === "bash" || PLANNING_SUBAGENT_TOOLS.has(tool)) {
      return planningBlock(unitType, policy.mode, `${tool} is not permitted (read-only)`);
    }
    // Unknown tool in read-only mode — block by default.
    return planningBlock(unitType, policy.mode, `tool "${tool}" is not on the read-only allowlist`);
  }

  // planning / planning-dispatch / docs / verification modes share the same surface for safe tools, bash, and subagent.
  if (PLANNING_SAFE_TOOLS.has(tool)) return { block: false };
  if (tool.startsWith("gsd_")) return { block: false };

  if (PLANNING_SUBAGENT_TOOLS.has(tool)) {
    if (allowsControlledSubagentDispatch(policy)) {
      const requested = (agentClasses ?? []).map(a => a.trim()).filter(Boolean);
      const dispatchContract = compileSubagentPermissionContract(policy);
      const allowedSubagents = dispatchContract.allowedSubagents;
      const allowed = new Set(allowedSubagents);
      const planningSubagentRegistry = loadEffectiveGSDPreferences(basePath)?.preferences.planning_subagent_registry;
      // When agentClasses is undefined, the caller has not been updated to extract
      // agent identities yet. Block and warn so stale callers surface in telemetry
      // instead of silently bypassing the gate.
      if (agentClasses === undefined) {
        warnMissingControlledDispatchAgentClasses(unitType, policy.mode, tool);
        return planningBlock(
          unitType,
          policy.mode,
          `subagent dispatch blocked: stale caller did not supply agent identities for "${tool}"; update extractSubagentAgentClasses to handle this input shape`,
        );
      }
      // agentClasses was explicitly provided but resolved to an empty list (for
      // example, a bare tool call with no agent field). Pass through; no agents
      // to validate means the downstream tool call itself will fail.
      if (requested.length === 0) {
        return { block: false };
      }
      const globallyDisallowed = requested.find(a => !isReadOnlyPlanningDispatchAgent(a, planningSubagentRegistry));
      if (globallyDisallowed) {
        return planningBlock(
          unitType,
          policy.mode,
          `subagent dispatch of "${globallyDisallowed}" not permitted; only read-only specialists (${allowedPlanningDispatchAgentsList(planningSubagentRegistry)}) may be dispatched from ${policy.mode} units`,
        );
      }
      const disallowedByPolicy = requested.find(a => !allowed.has(a));
      if (disallowedByPolicy) {
        return planningBlock(
          unitType,
          policy.mode,
          `subagent dispatch of "${disallowedByPolicy}" not permitted by unit allowlist (ToolsPolicy.allowedSubagents/planning_subagents); permitted agents for this unit: ${allowedSubagents.join(", ")}`,
        );
      }
      return { block: false };
    }
    return planningBlock(unitType, policy.mode, "subagent dispatch is not permitted in planning units");
  }

  if (policy.mode === "workflow-only") {
    if (tool === "bash") {
      return planningBlock(
        unitType,
        policy.mode,
        `bash is not permitted; use the unit's dedicated GSD workflow tools for durable validation output`,
      );
    }
    if (PLANNING_WRITE_TOOLS.has(tool)) {
      return planningBlock(
        unitType,
        policy.mode,
        `cannot ${tool} "${pathOrCommand}" — direct artifact writes are disabled; call the required GSD workflow tool instead`,
      );
    }
    return planningBlock(unitType, policy.mode, `tool "${tool}" is not on the workflow-only allowlist`);
  }

  if (tool === "bash") {
    if (policy.mode === "verification") {
      if (BASH_VERIFICATION_RE.test(pathOrCommand) || BASH_READ_ONLY_RE.test(pathOrCommand)) return { block: false };
      return planningBlock(
        unitType,
        policy.mode,
        `bash is restricted to build/test verification commands (npm run build, npm test, etc.); cannot run "${pathOrCommand.slice(0, 80)}${pathOrCommand.length > 80 ? "…" : ""}"`,
      );
    }
    if (BASH_READ_ONLY_RE.test(pathOrCommand)) return { block: false };
    return planningBlock(
      unitType,
      policy.mode,
      `bash is restricted to read-only commands (cat/grep/git log/etc); cannot run "${pathOrCommand.slice(0, 80)}${pathOrCommand.length > 80 ? "…" : ""}"`,
    );
  }

  if (PLANNING_WRITE_TOOLS.has(tool)) {
    if (!pathOrCommand) {
      return planningBlock(unitType, policy.mode, `${tool} called with empty path`);
    }
    const absPath = isAbsolute(pathOrCommand) ? pathOrCommand : resolve(basePath, pathOrCommand);

    // Always allow .gsd/ writes — that's where planning artifacts live.
    if (isPathUnderGsd(absPath, basePath)) return { block: false };

    // docs mode additionally allows the manifest's allowedPathGlobs.
    if (policy.mode === "docs" && matchesAllowedGlob(absPath, basePath, policy.allowedPathGlobs)) {
      return { block: false };
    }

    return planningBlock(
      unitType,
      policy.mode,
      `cannot ${tool} "${pathOrCommand}" — writes are restricted to .gsd/${policy.mode === "docs" ? " and " + policy.allowedPathGlobs.join(", ") : ""}`,
    );
  }

  // Unknown tool name — pass through. Other layers (queue, pending-gate,
  // CONTEXT.md write) catch known mutating shapes; defaulting to allow here
  // avoids breaking gsd_* MCP tools or future safe additions.
  return { block: false };
}

// ─── Worktree isolation write gate (#5199) ────────────────────────────────
//
// When `git.isolation: worktree` is configured, the per-unit commit pipeline
// only runs inside the auto-mode loop (`auto-post-unit.ts`). If the LLM
// authors code at the project root before auto-mode is started, those writes
// land in the working tree but never reach a commit — they're silently
// orphaned outside git history. This guard blocks those writes at the
// tool_call seam so the agent receives a clear error instead.

const WORKTREE_GATE_BOOTSTRAP_UNITS = new Set([
  "discuss-milestone",
  "plan-milestone",
  "init",
]);

function realpathOrResolve(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Path doesn't exist (yet) — realpath the deepest existing ancestor so
    // platforms where /tmp -> /private/tmp don't break containment checks.
    let dir = abs;
    const tail: string[] = [];
    while (dir && dir !== resolve(dir, "..")) {
      try {
        const real = realpathSync(dir);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const idx = dir.lastIndexOf(sep);
        if (idx <= 0) break;
        tail.push(dir.slice(idx + 1));
        dir = dir.slice(0, idx) || sep;
      }
    }
    return abs;
  }
}

function isPathContained(target: string, container: string): boolean {
  if (target === container) return true;
  return target.startsWith(container.endsWith(sep) ? container : container + sep);
}

function formatWorktreeIsolationBlockReason(
  tool: string,
  displayTarget: string,
  isAutoLive: boolean,
  effectiveBasePath: string,
): string {
  if (isGsdWorktreePath(effectiveBasePath)) {
    return [
      `HARD BLOCK: ${tool} target "${displayTarget}" is outside the active milestone worktree`,
      `while \`git.isolation: worktree\` is configured. Source edits must stay inside`,
      `\`.gsd-worktrees/<MID>/\` (or \`.gsd/\` planning artifacts) so the auto-mode commit`,
      `pipeline captures them. Writing to the project root leaks changes that block milestone merge.`,
      `Use a relative path under the worktree cwd or an absolute path inside the worktree directory.`,
      ...(isAutoLive ? [] : [
        "This guard also applies to subagent children spawned from the worktree — do not",
        "`cd` to the project root or reference its paths in shell commands.",
      ]),
    ].join(" ");
  }

  if (isAutoLive) {
    return [
      `HARD BLOCK: Worktree isolation is configured (\`git.isolation: worktree\`) and auto-mode is running,`,
      `but the target "${displayTarget}" is not inside \`.gsd/worktrees/<MID>/\`.`,
      `The live session has not entered degraded branch-mode fallback, so project-root code edits`,
      `would be lost by the worktree commit pipeline. Write inside the active milestone worktree.`,
      `If worktree setup failed, restart auto-mode so branch-mode fallback can be established.`,
    ].join(" ");
  }

  return [
    `HARD BLOCK: Worktree isolation is configured (\`git.isolation: worktree\`) but auto-mode is`,
    `not running and the target "${displayTarget}" is not inside \`.gsd/worktrees/<MID>/\`.`,
    `Code edits at the project root would be lost — only the auto-mode commit pipeline`,
    `(auto-post-unit) commits work, and it never runs outside the loop.`,
    `Required action: start auto-mode with \`/gsd\` so the milestone worktree is created,`,
    `then write inside it. To disable this guard for self-hosting development, set`,
    `GSD_DISABLE_WORKTREE_WRITE_GUARD=1.`,
  ].join(" ");
}

/**
 * Block planning-write tool calls that would land code at the project root
 * while effective `git.isolation: worktree` is in effect and auto-mode hasn't
 * created (or flipped cwd into) the milestone worktree. Degraded/recovery
 * branch mode deliberately bypasses this guard.
 *
 * Pure / unit-testable. Callers in `register-hooks.ts` supply the effective
 * execution base path (worker cwd or project root) and current auto liveness;
 * this function does no I/O beyond realpath resolution.
 *
 * Allow rules (in order):
 *   1. Tool isn't a planning-write (write/edit/multi_edit/notebook_edit).
 *   2. `GSD_DISABLE_WORKTREE_WRITE_GUARD=1` self-hosting bypass.
 *   3. Effective isolation mode is not "worktree".
 *   4. Active unit is a bootstrap unit (discuss-milestone/plan-milestone/init).
 *   5. Target is inside `<projectRoot>/.gsd/worktrees/` (a real worktree).
 *   6. Target is inside `<projectRoot>/.gsd/` and isn't masquerading as a
 *      worktrees sibling (rejects the `.gsd/worktrees-extra/…` prefix trick).
 *
 * Otherwise: block with a message that points the agent at the active worktree
 * or `/gsd` to start auto-mode.
 */
export function shouldBlockWorktreeWrite(
  toolName: string,
  targetPath: string,
  effectiveBasePath: string,
  isAutoLive: boolean,
  currentUnitType?: string | null,
  effectiveIsolationMode?: ReturnType<typeof getIsolationMode>,
): { block: boolean; reason?: string } {
  const tool = canonicalToolName(toolName);
  if (!PLANNING_WRITE_TOOLS.has(tool)) return { block: false };
  if (process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD === "1") return { block: false };
  if ((effectiveIsolationMode ?? getIsolationMode(effectiveBasePath)) !== "worktree") {
    return { block: false };
  }
  if (currentUnitType && WORKTREE_GATE_BOOTSTRAP_UNITS.has(currentUnitType)) return { block: false };

  if (!targetPath) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: ${tool} called with empty path while \`git.isolation: worktree\` is configured`,
        isAutoLive
          ? `and auto-mode is running. Refusing to allow writes that cannot be located.`
          : `and auto-mode is not active. Refusing to allow writes that cannot be located.`,
      ].join(" "),
    };
  }

  // Resolve relative targets against the effective execution base path, then
  // canonicalize against the project root to defeat
  // symlink-based escapes and prefix tricks (e.g. .gsd/worktrees-extra/).
  const projectRoot = resolveWorktreeProjectRoot(effectiveBasePath);
  const absTarget = isAbsolute(targetPath) ? targetPath : resolve(effectiveBasePath, targetPath);
  const realTarget = realpathOrResolve(absTarget);
  const realRoot = realpathOrResolve(projectRoot);
  const realGsd = realpathOrResolve(join(projectRoot, ".gsd"));

  // Allow writes inside a legitimate worktrees subtree (canonical
  // .gsd-worktrees/ or legacy .gsd/worktrees/).
  for (const container of worktreesDirs(projectRoot)) {
    if (isPathContained(realTarget, realpathOrResolve(container))) return { block: false };
  }

  // Allow writes to .gsd/ planning artifacts, but reject siblings whose name
  // starts with "worktrees" (the worktrees-extra prefix trick — case 4).
  if (isPathContained(realTarget, realGsd)) {
    const rel = relative(realGsd, realTarget);
    const firstSeg = rel.split(/[\/\\]/)[0] ?? "";
    if (!firstSeg.startsWith("worktrees")) return { block: false };
    // fall through: looks like worktrees<something> sibling — block
  }

  // Block. Provide enough context that the agent can self-correct.
  const displayTarget = isPathContained(realTarget, realRoot)
    ? relative(realRoot, realTarget) || "."
    : realTarget;
  return {
    block: true,
    reason: formatWorktreeIsolationBlockReason(tool, displayTarget, isAutoLive, effectiveBasePath),
  };
}

/**
 * Block bash commands that reference the project root while executing inside an
 * active milestone worktree under `git.isolation: worktree`.
 *
 * Mirrors the gsd_exec sandbox rule so native bash cannot bypass write/edit gates.
 */
export function shouldBlockWorktreeBash(
  command: string,
  effectiveBasePath: string,
  isAutoLive: boolean,
  currentUnitType?: string | null,
  effectiveIsolationMode?: ReturnType<typeof getIsolationMode>,
): { block: boolean; reason?: string } {
  if (process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD === "1") return { block: false };
  if ((effectiveIsolationMode ?? getIsolationMode(effectiveBasePath)) !== "worktree") {
    return { block: false };
  }
  if (currentUnitType && WORKTREE_GATE_BOOTSTRAP_UNITS.has(currentUnitType)) return { block: false };
  // Block whenever the effective cwd is inside a milestone worktree — not only
  // during live auto-mode. Reactive-execute subagents run as fresh pi children
  // without an auto session, but still inherit the worktree cwd and must not
  // shell out to the project root (the native bash bypass that caused root-write leaks).
  if (!isGsdWorktreePath(effectiveBasePath)) return { block: false };
  if (!command.trim()) return { block: false };
  if (!bashReferencesProjectRootOutsideWorktree(command, effectiveBasePath)) return { block: false };

  return {
    block: true,
    reason: formatWorktreeIsolationBlockReason(
      "bash",
      "project root path reference in shell command",
      isAutoLive,
      effectiveBasePath,
    ),
  };
}
