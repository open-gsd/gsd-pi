// gsd-pi - Write gate runtime persistence and policy guards.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { minimatch } from "minimatch";

import { GSD_PHASE_SCOPE_DISPLAY_REASON, shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.js";
import { canonicalToolName } from "../engine-hook-contract.js";
import { loadJsonFileOrNull } from "../json-persistence.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "../preferences.js";
import { compileSubagentPermissionContract, type ToolsPolicy } from "../unit-context-manifest.js";
import {
  allowedPlanningDispatchAgentsList,
  isReadOnlyPlanningDispatchAgent,
} from "../planning-subagent-registry.js";
import { logWarning } from "../workflow-logger.js";
import { acquireSyncLock, releaseSyncLock } from "../sync-lock.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "../worktree-root.js";
import { worktreesDirs } from "../worktree-placement.js";
import { bashReferencesProjectRootOutsideWorktree } from "../worktree-shell-guard.js";
import { evaluateGateAnswer } from "../consent-verdict.js";

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
  "gsd_summary_save",
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

interface InMemoryWriteGateState {
  verifiedDepthMilestones: Set<string>;
  verifiedApprovalGates: Set<string>;
  activeQueuePhase: boolean;
  pendingGateId: string | null;
}

function createEmptyWriteGateState(): InMemoryWriteGateState {
  return {
    verifiedDepthMilestones: new Set<string>(),
    verifiedApprovalGates: new Set<string>(),
    activeQueuePhase: false,
    pendingGateId: null,
  };
}

const writeGateStatesByBasePath = new Map<string, InMemoryWriteGateState>();

/**
 * Write-gate snapshots are project-scoped, not worktree-scoped. When auto-mode
 * routes MCP tool writes to `.gsd-worktrees/<MID>/`, depth verification still
 * lands in the authoritative project `.gsd/runtime/` tree (or external-state
 * symlink target). Without this canonicalization, `loadWriteGateSnapshot(worktree)`
 * sees an empty snapshot and CONTEXT saves loop forever (#M020 gate loop).
 */
function resolveWriteGateSnapshotRoot(basePath: string): string {
  return resolve(resolveWorktreeProjectRoot(basePath));
}

function writeGateStateKey(basePath: string): string {
  return resolveWriteGateSnapshotRoot(basePath);
}

function getWriteGateState(basePath: string = process.cwd()): InMemoryWriteGateState {
  const key = writeGateStateKey(basePath);
  let state = writeGateStatesByBasePath.get(key);
  if (!state) {
    state = createEmptyWriteGateState();
    writeGateStatesByBasePath.set(key, state);
  }
  return state;
}

/**
 * Discussion gate enforcement state is scoped per basePath so multiple
 * workspaces can coexist in the same process without sharing gate state.
 */

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
 * Which process wrote a snapshot. Two processes share the snapshot file:
 * the extension host ("host") and the workflow MCP child ("child"), which
 * dynamically imports this same compiled module in its own process.
 */
export type WriteGateWriter = "host" | "child";

export interface WriteGateSnapshot {
  verifiedDepthMilestones: string[];
  verifiedApprovalGates?: string[];
  activeQueuePhase: boolean;
  pendingGateId: string | null;
  /** Tag of the process that produced this snapshot (diagnostic only). */
  writer?: WriteGateWriter;
}

/**
 * Persistence is ON by default (opt-out).
 * Set GSD_PERSIST_WRITE_GATE_STATE="0" or GSD_PERSIST_WRITE_GATE_STATE="false"
 * to disable. All other values — including unset — persist the snapshot.
 * (Inverted from the original opt-in guard; see #4950.)
 */
function shouldPersistWriteGateSnapshot(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GSD_PERSIST_WRITE_GATE_STATE;
  return v !== "0" && v !== "false";
}

function writeGateSnapshotPath(basePath: string): string {
  return join(resolveWriteGateSnapshotRoot(basePath), ".gsd", "runtime", "write-gate-state.json");
}

function ensureWriteGateSnapshotDirectory(basePath: string): void {
  const snapshotRoot = resolveWriteGateSnapshotRoot(basePath);
  const gsdPath = join(snapshotRoot, ".gsd");
  if (!existsSync(gsdPath)) {
    try {
      const stat = lstatSync(gsdPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(gsdPath);
        mkdirSync(isAbsolute(target) ? target : resolve(snapshotRoot, target), { recursive: true });
      }
    } catch {
      // If .gsd truly does not exist, the runtime mkdir below will create it.
    }
  }
  mkdirSync(join(gsdPath, "runtime"), { recursive: true });
}

export function currentWriteGateSnapshot(basePath: string = process.cwd()): WriteGateSnapshot {
  const state = getWriteGateState(basePath);
  return {
    verifiedDepthMilestones: [...state.verifiedDepthMilestones].sort(),
    verifiedApprovalGates: [...state.verifiedApprovalGates].sort(),
    activeQueuePhase: state.activeQueuePhase,
    pendingGateId: state.pendingGateId,
  };
}

function writeSnapshotFileAtomic(basePath: string, snapshot: WriteGateSnapshot): void {
  const path = writeGateSnapshotPath(basePath);
  ensureWriteGateSnapshotDirectory(basePath);
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), "utf-8");
  try {
    renameSync(tempPath, path);
  } catch (err: unknown) {
    // EXDEV: cross-device rename (temp and dest on different mounts). Fall back
    // to copy-then-delete so the snapshot is still written atomically enough.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(tempPath, path);
      unlinkSync(tempPath);
    } else {
      throw err;
    }
  }
}

/**
 * Persist the current in-memory state for `basePath`, stamped with the
 * writer provenance tag. Callers (mutateWriteGateState / childMutate) are
 * responsible for first reconciling in-memory content against the disk
 * snapshot — the read-merge-write sequence is synchronous, so a concurrent
 * writer's update is folded in by that unconditional pre-persist read.
 */
function persistWriteGateSnapshot(basePath: string, writer: WriteGateWriter): void {
  if (!shouldPersistWriteGateSnapshot()) return;
  writeSnapshotFileAtomic(basePath, { ...currentWriteGateSnapshot(basePath), writer });
}

function clearPersistedWriteGateSnapshot(basePath: string): void {
  if (!shouldPersistWriteGateSnapshot()) return;
  const path = writeGateSnapshotPath(basePath);
  try {
    unlinkSync(path);
  } catch {
    // swallow
  }
}

function normalizeWriteGateSnapshot(value: unknown): WriteGateSnapshot {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const verified = Array.isArray(record.verifiedDepthMilestones)
    ? record.verifiedDepthMilestones
        .filter((item): item is string => typeof item === "string")
        .map(normalizeMilestoneId)
    : [];
  const verifiedGates = Array.isArray(record.verifiedApprovalGates)
    ? record.verifiedApprovalGates.filter((item): item is string => typeof item === "string")
    : [];
  return {
    verifiedDepthMilestones: [...new Set(verified)].sort(),
    verifiedApprovalGates: [...new Set(verifiedGates)].sort(),
    activeQueuePhase: record.activeQueuePhase === true,
    pendingGateId: typeof record.pendingGateId === "string" ? record.pendingGateId : null,
    ...(record.writer === "host" || record.writer === "child" ? { writer: record.writer } : {}),
  };
}

const EMPTY_SNAPSHOT: WriteGateSnapshot = {
  verifiedDepthMilestones: [],
  verifiedApprovalGates: [],
  activeQueuePhase: false,
  pendingGateId: null,
};

/**
 * Read the snapshot file as it exists on disk. Returns null when the file
 * is missing or unparseable (no in-memory fallback — callers decide).
 */
function readDiskSnapshot(basePath: string): WriteGateSnapshot | null {
  const raw = loadJsonFileOrNull(
    writeGateSnapshotPath(basePath),
    (data): data is Record<string, unknown> => typeof data === "object" && data !== null,
  );
  return raw === null ? null : normalizeWriteGateSnapshot(raw);
}

export function loadWriteGateSnapshot(basePath: string): WriteGateSnapshot {
  const path = writeGateSnapshotPath(basePath);
  if (!existsSync(path)) {
    // When persist mode is active and the file has been deleted, treat it as a
    // full state reset so deleting the file clears the HARD BLOCK gate.
    // In non-persist mode the file is never written, so fall back to in-memory.
    if (shouldPersistWriteGateSnapshot()) return EMPTY_SNAPSHOT;
    return currentWriteGateSnapshot(basePath);
  }
  const disk = readDiskSnapshot(basePath);
  return disk ?? currentWriteGateSnapshot(basePath);
}

/**
 * Reconcile a disk snapshot into the in-memory state. This is THE merge
 * rule for the two-process seam:
 *
 *   - verifications are a grow-only union: a milestone/gate verified by
 *     either process is never lost to a stale write from the other;
 *   - activeQueuePhase and pendingGateId take the disk value (last writer
 *     wins — matches the long-standing refresh semantics, and keeps
 *     "delete the snapshot file to clear the HARD BLOCK" working);
 *   - verified wins over pending: if the merged verified sets already cover
 *     the pending gate (gate id verified, or its depth milestone verified),
 *     the pending re-arm is dropped. This generalizes the ad-hoc re-arm
 *     guard that previously protected only the tool_execution_start window.
 */
function mergeSnapshotIntoState(state: InMemoryWriteGateState, disk: WriteGateSnapshot): void {
  for (const milestone of disk.verifiedDepthMilestones) state.verifiedDepthMilestones.add(normalizeMilestoneId(milestone));
  for (const gate of disk.verifiedApprovalGates ?? []) state.verifiedApprovalGates.add(gate);
  state.activeQueuePhase = disk.activeQueuePhase;
  state.pendingGateId = disk.pendingGateId;
  dropVerifiedPendingGate(state);
}

/** Verified-on-disk wins over a pending re-arm (see mergeSnapshotIntoState). */
function dropVerifiedPendingGate(state: InMemoryWriteGateState): void {
  const pending = state.pendingGateId;
  if (!pending) return;
  const milestoneId = extractDepthVerificationMilestoneId(pending);
  if (
    state.verifiedApprovalGates.has(pending) ||
    (milestoneId !== null && state.verifiedDepthMilestones.has(milestoneId))
  ) {
    state.pendingGateId = null;
  }
}

function replaceStateFromSnapshot(state: InMemoryWriteGateState, snapshot: WriteGateSnapshot): void {
  state.pendingGateId = snapshot.pendingGateId;
  state.activeQueuePhase = snapshot.activeQueuePhase;
  state.verifiedDepthMilestones = new Set(snapshot.verifiedDepthMilestones);
  state.verifiedApprovalGates = new Set(snapshot.verifiedApprovalGates ?? []);
}

/**
 * Reconcile the persisted write-gate snapshot into the in-process Map entry.
 * The workflow MCP server runs in a child process and records depth
 * verification there; without this refresh the extension host keeps stale
 * pending-gate memory and `activateDeferredApprovalGate` can re-arm a gate
 * that the subprocess already cleared on disk.
 *
 * Uses the union merge rule (mergeSnapshotIntoState) when a readable
 * snapshot file exists; a missing or unparseable file is a full reset
 * (replace with empty) so deleting the file still clears all gate state,
 * and a corrupt file does not leave stale `pendingGateId` in memory for
 * the next mutation to persist back.
 *
 * Returns the reconciled snapshot so callers that need to inspect it
 * (e.g. re-arm guards) avoid a second disk read.
 */
export function refreshWriteGateStateFromDisk(basePath: string): WriteGateSnapshot {
  if (!shouldPersistWriteGateSnapshot()) return currentWriteGateSnapshot(basePath);
  const state = getWriteGateState(basePath);
  const disk = readDiskSnapshot(basePath);
  if (disk) {
    mergeSnapshotIntoState(state, disk);
  } else {
    replaceStateFromSnapshot(state, EMPTY_SNAPSHOT);
  }
  return currentWriteGateSnapshot(basePath);
}

const WRITE_GATE_LOCK_NAME = "write-gate.lock";

/**
 * Test-only seam: fires once inside the held cross-process lock (after acquire,
 * before the read-merge-write body) with the resolved lock root. Lets a
 * regression test observe that a concurrent process is genuinely locked out of
 * the critical section. Production leaves it null. Follows the repo's
 * `_setGhAvailableForTest` naming convention.
 */
let interleaveHookForTest: ((lockRoot: string) => void) | null = null;
export function _setWriteGateInterleaveHookForTest(fn: ((lockRoot: string) => void) | null): void {
  interleaveHookForTest = fn;
}

/**
 * Serialize the read-merge-write critical section across the two processes
 * that share the snapshot file (extension host + workflow MCP child). Atomic
 * rename prevents torn files but not lost updates: without this lock the host
 * can read the snapshot, the child can arm a gate and persist, then the host's
 * later persist overwrites `pendingGateId`/`activeQueuePhase` (last-writer-wins
 * fields) and silently drops the armed HARD-BLOCK gate.
 *
 * Fail-OPEN by contract: if a live peer holds the lock we proceed WITHOUT it —
 * exactly the racy-but-functional behavior that shipped before this lock — and
 * log once. The lock shrinks the race window to ~zero; it must never block,
 * throw, or refuse a gate mutation. The lock is skipped entirely when snapshot
 * persistence is off (no disk file, no cross-process seam).
 */
function withWriteGateLock<T>(basePath: string, fn: () => T): T {
  if (!shouldPersistWriteGateSnapshot()) return fn();
  const lockRoot = resolveWriteGateSnapshotRoot(basePath);
  // Materialize `.gsd/` (including a dangling external-state symlink target)
  // before locking. acquireSyncLock's own mkdir does NOT follow a symlink to
  // create its target, so without this the O_EXCL open lands on a missing
  // parent and the lock silently fails open — leaving the seam unserialized
  // for exactly the external-state projects that need it. This is the same
  // directory the persist path ensures anyway.
  try { ensureWriteGateSnapshotDirectory(basePath); } catch { /* best-effort; acquire fails-open below */ }
  const { acquired } = acquireSyncLock(lockRoot, 0, WRITE_GATE_LOCK_NAME);
  if (!acquired) {
    logWarning("intercept", "write-gate: proceeding without cross-process lock (held by live peer)", { lockRoot });
    return fn();
  }
  try {
    interleaveHookForTest?.(lockRoot);
    return fn();
  } finally {
    releaseSyncLock(lockRoot, WRITE_GATE_LOCK_NAME);
  }
}

/**
 * Read-modify-write primitive for gate mutations. Reconciles the disk
 * snapshot into memory (union merge), applies the mutation on top, then
 * persists — all under the cross-process lock (withWriteGateLock). The whole
 * sequence is synchronous, so the reconcile read doubles as the pre-persist
 * merge of concurrent writes; there is no version field.
 *
 * The mutate callback sees the already-reconciled state, so policy checks
 * (e.g. host setPending's verified-on-disk-wins guard) can live inside it
 * without a second disk read. Returning `false` from the callback aborts:
 * nothing is persisted and this function returns false.
 *
 * `reconcile: false` skips the disk merge — used for intentional full
 * resets where re-unioning disk verifications would defeat the reset.
 */
function mutateWriteGateState(
  basePath: string,
  mutate: (state: InMemoryWriteGateState) => void | false,
  opts?: { writer?: WriteGateWriter; reconcile?: boolean },
): boolean {
  const state = getWriteGateState(basePath);
  return withWriteGateLock(basePath, () => {
    if (shouldPersistWriteGateSnapshot() && (opts?.reconcile ?? true)) {
      const disk = readDiskSnapshot(basePath);
      if (disk) {
        mergeSnapshotIntoState(state, disk);
      } else {
        // Missing OR unparseable on disk: treat as a full reset. Keeping
        // stale in-memory state across a corrupt snapshot would persist it
        // back on this very mutation and defeat the documented
        // "delete the file to clear the HARD BLOCK gate" escape hatch.
        replaceStateFromSnapshot(state, EMPTY_SNAPSHOT);
      }
    }
    if (mutate(state) === false) return false;
    persistWriteGateSnapshot(basePath, opts?.writer ?? defaultWriteGateWriter());
    return true;
  });
}

export function isDepthVerified(basePath: string = process.cwd()): boolean {
  return getWriteGateState(basePath).verifiedDepthMilestones.size > 0;
}

/**
 * Check whether a specific milestone has passed depth verification.
 */
export function isMilestoneDepthVerified(
  milestoneId: string | null | undefined,
  basePath: string = process.cwd(),
): boolean {
  if (!milestoneId) return false;
  refreshWriteGateStateFromDisk(basePath);
  return getWriteGateState(basePath).verifiedDepthMilestones.has(normalizeMilestoneId(milestoneId));
}

export function isMilestoneDepthVerifiedInSnapshot(
  snapshot: WriteGateSnapshot,
  milestoneId: string | null | undefined,
): boolean {
  if (!milestoneId) return false;
  return snapshot.verifiedDepthMilestones.includes(normalizeMilestoneId(milestoneId));
}

export function isQueuePhaseActive(basePath: string = process.cwd()): boolean {
  return getWriteGateState(basePath).activeQueuePhase;
}

export function setQueuePhaseActive(active: boolean, basePath: string): void {
  mutateWriteGateState(basePath, (state) => {
    state.activeQueuePhase = active;
  });
}

export function resetWriteGateState(basePath: string): void {
  mutateWriteGateState(basePath, (state) => {
    state.verifiedDepthMilestones.clear();
    state.verifiedApprovalGates.clear();
    state.pendingGateId = null;
  }, { reconcile: false });
}

export function clearDiscussionFlowState(basePath: string): void {
  writeGateStatesByBasePath.delete(writeGateStateKey(basePath));
  clearPersistedWriteGateSnapshot(basePath);
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
 * prior verification); in the host the adapter's verified-on-disk-wins
 * guard applies and a suppressed arm returns false.
 *
 * Ambient (env-sniffed) export, reserved for the child's dynamic-import
 * surface (packages/mcp-server). Host-owned modules must call
 * hostWriteGateAdapter.setPending explicitly.
 */
export function setPendingGate(gateId: string, basePath: string): boolean {
  return defaultWriteGateAdapter().setPending(gateId, basePath);
}

/** Arm `gateId` on a reconciled state, revoking its prior verification. */
function armPendingGate(state: InMemoryWriteGateState, gateId: string): void {
  state.pendingGateId = gateId;
  state.verifiedApprovalGates.delete(gateId);
  const milestoneId = extractDepthVerificationMilestoneId(gateId);
  if (milestoneId) state.verifiedDepthMilestones.delete(milestoneId);
}

/**
 * Clear the pending gate (called when the user confirms).
 * Ambient export for the child's dynamic-import surface — host-owned
 * modules must call hostWriteGateAdapter.clearPending explicitly.
 */
export function clearPendingGate(basePath: string): void {
  defaultWriteGateAdapter().clearPending(basePath);
}

/**
 * Get the currently pending gate, if any.
 * Ambient export for the child's dynamic-import surface — host-owned
 * modules should prefer hostWriteGateAdapter.readState.
 */
export function getPendingGate(basePath: string = process.cwd()): string | null {
  return defaultWriteGateAdapter().readState(basePath).pendingGateId;
}

// ─── Write-gate two-process seam ─────────────────────────────────────────────
//
// Two processes write .gsd/runtime/write-gate-state.json: the extension host
// and the workflow MCP child (which dynamically imports this same compiled
// module — see GSD_WORKFLOW_WRITE_GATE_MODULE in workflow-mcp.ts and
// packages/mcp-server/src/server.ts). The adapters below name that seam:
// every cross-process interleaving reduces to "host adapter op vs child
// adapter op", which is deterministic given the merge rule documented on
// mergeSnapshotIntoState plus the unconditional read-merge-write persist.

export interface WriteGateStateAdapter {
  readonly writer: WriteGateWriter;
  /** Fresh (child) or disk-reconciled (host) view of gate state. */
  readState(basePath: string): WriteGateSnapshot;
  markDepthVerified(milestoneId: string | null | undefined, basePath: string): void;
  markApprovalGateVerified(gateId: string | null | undefined, basePath: string): void;
  /**
   * Arm a pending gate. Returns false when the adapter's policy suppressed
   * the arm (host: gate already verified on disk — verified wins over a
   * stale re-arm). Child adapter always arms (a fresh question intentionally
   * revokes prior verification).
   */
  setPending(gateId: string, basePath: string): boolean;
  clearPending(basePath: string): void;
}

/**
 * HOST adapter: in-memory state + reconcile-on-read. Disk verifications are
 * never lost (union merge), and a gate verified on disk wins over an
 * in-memory pending re-arm — setPending refuses to clobber a verification
 * the child already recorded. This generalizes the ad-hoc re-arm guard that
 * previously protected only the tool_execution_start window in
 * register-hooks.ts.
 */
export const hostWriteGateAdapter: WriteGateStateAdapter = {
  writer: "host",
  readState(basePath: string): WriteGateSnapshot {
    return refreshWriteGateStateFromDisk(basePath);
  },
  markDepthVerified(milestoneId, basePath): void {
    if (!milestoneId) return;
    mutateWriteGateState(basePath, (state) => {
      state.verifiedDepthMilestones.add(normalizeMilestoneId(milestoneId));
    }, { writer: "host" });
  },
  markApprovalGateVerified(gateId, basePath): void {
    if (!gateId) return;
    mutateWriteGateState(basePath, (state) => {
      state.verifiedApprovalGates.add(gateId);
    }, { writer: "host" });
  },
  setPending(gateId: string, basePath: string): boolean {
    // The verified-check runs inside the mutate callback so the single
    // reconcile read in mutateWriteGateState serves both the guard and the
    // pre-persist merge. A suppressed arm aborts without persisting.
    return mutateWriteGateState(basePath, (state) => {
      if (state.verifiedApprovalGates.has(gateId)) return false;
      const milestoneId = extractDepthVerificationMilestoneId(gateId);
      if (milestoneId && state.verifiedDepthMilestones.has(milestoneId)) return false;
      armPendingGate(state, gateId);
    }, { writer: "host" });
  },
  clearPending(basePath: string): void {
    mutateWriteGateState(basePath, (state) => {
      state.pendingGateId = null;
    }, { writer: "host" });
  },
};

/**
 * CHILD adapter: write-through with always-fresh reads — load the disk
 * snapshot, mutate, persist. No cross-turn in-memory state is trusted: the
 * in-process Map entry is replaced from disk before every mutation so a
 * long-lived MCP child never resurrects state the host has since changed.
 */
export const childWriteGateAdapter: WriteGateStateAdapter = {
  writer: "child",
  readState(basePath: string): WriteGateSnapshot {
    return loadWriteGateSnapshot(basePath);
  },
  markDepthVerified(milestoneId, basePath): void {
    if (!milestoneId) return;
    childMutate(basePath, (state) => {
      state.verifiedDepthMilestones.add(normalizeMilestoneId(milestoneId));
    });
  },
  markApprovalGateVerified(gateId, basePath): void {
    if (!gateId) return;
    childMutate(basePath, (state) => {
      state.verifiedApprovalGates.add(gateId);
    });
  },
  setPending(gateId: string, basePath: string): boolean {
    childMutate(basePath, (state) => armPendingGate(state, gateId));
    return true;
  },
  clearPending(basePath: string): void {
    childMutate(basePath, (state) => {
      state.pendingGateId = null;
    });
  },
};

function childMutate(basePath: string, mutate: (state: InMemoryWriteGateState) => void): void {
  const state = getWriteGateState(basePath);
  withWriteGateLock(basePath, () => {
    if (shouldPersistWriteGateSnapshot()) {
      // Always-fresh: disk is the only truth for the child; discard any
      // cross-turn in-memory residue before mutating.
      replaceStateFromSnapshot(state, readDiskSnapshot(basePath) ?? EMPTY_SNAPSHOT);
    }
    mutate(state);
    persistWriteGateSnapshot(basePath, "child");
  });
}

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
  return shouldBlockPendingGateInSnapshot(currentWriteGateSnapshot(basePath), toolName, milestoneId, queuePhaseActive);
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
  return shouldBlockPendingGateBashInSnapshot(currentWriteGateSnapshot(basePath), command, milestoneId, queuePhaseActive);
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
 * - "declined" verdict → no state change; the gate (if armed) stays pending.
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
): { block: boolean; reason?: string } {
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

  if (isMilestoneDepthVerified(targetMilestoneId, basePath)) return { block: false };

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
): { block: boolean; reason?: string } {
  return shouldBlockContextArtifactSaveInSnapshot(currentWriteGateSnapshot(basePath), artifactType, milestoneId, sliceId);
}

export function shouldBlockContextArtifactSaveInSnapshot(
  snapshot: WriteGateSnapshot,
  artifactType: string,
  milestoneId: string | null,
  sliceId?: string | null,
): { block: boolean; reason?: string } {
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
): { block: boolean; reason?: string } {
  if (!FINAL_ROOT_ARTIFACTS.has(artifactType)) return { block: false };

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
  return shouldBlockQueueExecutionInSnapshot(currentWriteGateSnapshot(), toolName, input, queuePhaseActive);
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
        `Write CONTEXT.md files and update PROJECT.md/QUEUE.md instead.`,
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
