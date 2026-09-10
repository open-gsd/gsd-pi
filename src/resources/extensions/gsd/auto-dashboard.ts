// gsd-pi + src/resources/extensions/gsd/auto-dashboard.ts - Auto-mode progress widget rendering and dashboard helpers.

/**
 * Auto-mode Dashboard — progress widget rendering, elapsed time formatting,
 * unit description helpers, and slice progress caching.
 *
 * Pure functions that accept specific parameters — no module-level globals
 * or AutoContext dependency. State accessors are passed as callbacks.
 */

import type {
  ExtensionContext,
  ExtensionCommandContext,
  GsdProgressState,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { getActiveHook } from "./post-unit-hooks.js";
import { filterUnitsForMilestone, getLedger, getProjectTotals } from "./metrics.js";
import { getErrorMessage } from "./error-utils.js";
import { nativeIsRepo } from "./native-git-bridge.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
} from "./paths.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI } from "../shared/tui.js";
import { GLYPH, INDENT } from "../shared/mod.js";
import { padRightVisible, renderPlainOutcome, renderProgressBar, rightAlign, wrapVisibleText } from "./tui/render-kit.js";
import { computeProgressScore } from "./progress-score.js";
import {
  getGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  parsePreferencesMarkdown,
} from "./preferences.js";
import { parseUnitId } from "./unit-id.js";
import {
  type RtkSessionSavings,
} from "../shared/rtk-session-stats.js";
import { logWarning } from "./workflow-logger.js";
import { formattedShortcutPair } from "./shortcut-defs.js";
import { readUnitRuntimeRecord, type AutoUnitRuntimeRecord } from "./unit-runtime.js";
import { describeMilestoneReadinessPhase } from "./milestone-readiness.js";
import type { ToolSurfaceSnapshot } from "./tool-surface-snapshot.js";

const ACTIVE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// ─── UAT Slice Extraction ─────────────────────────────────────────────────────

/**
 * Extract the target slice ID from a run-uat unit ID (e.g. "M001/S01" → "S01").
 * Returns null if the format doesn't match.
 */
export function extractUatSliceId(unitId: string): string | null {
  const { slice } = parseUnitId(unitId);
  if (slice?.startsWith("S")) return slice;
  return null;
}

// ─── Dashboard Data ───────────────────────────────────────────────────────────

/** Dashboard data for the overlay */
export interface AutoDashboardData {
  active: boolean;
  paused: boolean;
  stepMode: boolean;
  startTime: number;
  elapsed: number;
  currentUnit: { type: string; id: string; startedAt: number } | null;
  basePath: string;
  /** Running cost and token totals from metrics ledger */
  totalCost: number;
  totalTokens: number;
  /** Projected remaining cost based on unit-type averages (undefined if insufficient data) */
  projectedRemainingCost?: number;
  /** Whether token profile has been auto-downgraded due to budget prediction */
  profileDowngraded?: boolean;
  /** Number of pending captures awaiting triage (0 if none or file missing) */
  pendingCaptureCount: number;
  /** RTK token savings for the current session, or null when unavailable. */
  rtkSavings?: RtkSessionSavings | null;
  /** Whether RTK is enabled via experimental.rtk preference. False when not opted in. */
  rtkEnabled?: boolean;
  /** Cross-process: another auto-mode session detected via auto.lock (PID, startedAt) */
  remoteSession?: { pid: number; startedAt: string; unitType: string; unitId: string };
  /** Last typed tool-surface snapshot for active auto-mode scoping/debugging. */
  toolSurface?: ToolSurfaceSnapshot | null;
}

export interface CompletionDashboardSnapshot {
  milestoneId?: string | null;
  milestoneTitle?: string | null;
  oneLiner?: string | null;
  successCriteriaResults?: string | null;
  definitionOfDoneResults?: string | null;
  requirementOutcomes?: string | null;
  deviations?: string | null;
  followUps?: string | null;
  keyDecisions?: string[];
  keyFiles?: string[];
  lessonsLearned?: string[];
  reason: string;
  startedAt: number;
  totalCost: number;
  totalTokens: number;
  unitCount: number;
  cacheHitRate?: number | null;
  contextPercent?: number | null;
  contextWindow?: number | null;
  completedSlices?: number | null;
  totalSlices?: number | null;
  allMilestonesComplete?: boolean;
  unmappedActiveRequirements?: number;
  requirementsBacklogPreview?: string[];
  basePath?: string | null;
}

export interface AutoOutcomeSurfaceSnapshot {
  status: "paused" | "stopped" | "blocked" | "failed" | "complete" | "waiting" | "step";
  title: string;
  detail?: string | null;
  unitLabel?: string | null;
  nextAction: string;
  commands?: string[];
  startedAt?: number;
}

export function buildPhaseHandoffOutcome(input: {
  unitType: string;
  unitId: string;
  agentEndMessages?: unknown[] | null;
}): AutoOutcomeSurfaceSnapshot {
  const phase = unitPhaseLabel(input.unitType);
  const detail =
    extractLastAssistantSummary(input.agentEndMessages) ??
    `Completed ${unitVerb(input.unitType)} ${input.unitId}.`;

  return {
    status: "complete",
    title: `${phase} complete`,
    detail,
    unitLabel: `${unitVerb(input.unitType)} ${input.unitId}`,
    nextAction: "Preparing the next phase. Review this handoff while the next session starts.",
    commands: ["/gsd status for overview", "/gsd visualize to inspect", "/gsd notifications for history"],
  };
}

// ─── Unit Description Helpers ─────────────────────────────────────────────────

export function unitVerb(unitType: string): string {
  if (unitType.startsWith("hook/")) return `hook: ${unitType.slice(5)}`;
  switch (unitType) {
    case "discuss-milestone":
    case "discuss-slice": return "discussing";
    case "research-milestone":
    case "research-slice": return "researching";
    case "plan-milestone":
    case "plan-slice": return "planning";
    case "refine-slice": return "refining";
    case "execute-task": return "executing";
    case "complete-slice": return "completing";
    case "replan-slice": return "replanning";
    case "rewrite-docs": return "rewriting";
    case "reassess-roadmap": return "reassessing";
    case "run-uat": return "running UAT";
    case "custom-step": return "executing workflow step";
    default: return unitType;
  }
}

export function unitPhaseLabel(unitType: string): string {
  if (unitType.startsWith("hook/")) return "HOOK";
  switch (unitType) {
    case "discuss-milestone":
    case "discuss-slice": return "DISCUSS";
    case "research-milestone": return "RESEARCH";
    case "research-slice": return "RESEARCH";
    case "plan-milestone": return "PLAN";
    case "plan-slice": return "PLAN";
    case "refine-slice": return "REFINE";
    case "execute-task": return "EXECUTE";
    case "complete-slice": return "COMPLETE";
    case "replan-slice": return "REPLAN";
    case "rewrite-docs": return "REWRITE";
    case "reassess-roadmap": return "REASSESS";
    case "run-uat": return "UAT";
    case "custom-step": return "WORKFLOW";
    default: return unitType.toUpperCase();
  }
}

export function formatToolSurfaceSnapshot(snapshot: ToolSurfaceSnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  const counts = [
    `model ${snapshot.modelFacingToolNames.length}`,
    `registered ${snapshot.registeredToolNames.length}`,
    `scoped ${snapshot.scopedToolNames.length}`,
    `presented ${snapshot.presentedToolNames.length}`,
  ];
  const label = snapshot.unitType ?? snapshot.phase ?? snapshot.source;
  return `${label}: ${counts.join(" / ")}`;
}

function peekNext(unitType: string, state: GSDState): string {
  // Show active hook info in progress display
  const activeHookState = getActiveHook();
  if (activeHookState) {
    return `hook: ${activeHookState.hookName} (cycle ${activeHookState.cycle})`;
  }

  const sid = state.activeSlice?.id ?? "";
  if (unitType.startsWith("hook/")) return `continue ${sid}`;
  switch (unitType) {
    case "discuss-milestone": return "research or plan milestone";
    case "discuss-slice": return "plan slice";
    case "research-milestone": return "plan milestone roadmap";
    case "plan-milestone": return "plan or execute first slice";
    case "research-slice": return `plan ${sid}`;
    case "plan-slice": return "execute first task";
    case "refine-slice": return "execute first task";
    case "execute-task": return `continue ${sid}`;
    case "complete-slice": return "reassess roadmap";
    case "replan-slice": return `re-execute ${sid}`;
    case "rewrite-docs": return "continue execution";
    case "reassess-roadmap": return "advance to next slice";
    case "run-uat": return "reassess roadmap";
    default: return "";
  }
}

/**
 * Describe what the next unit will be, based on current state.
 */
export function describeNextUnit(state: GSDState): { label: string; description: string } {
  const sid = state.activeSlice?.id;
  const sTitle = state.activeSlice?.title;
  const tid = state.activeTask?.id;
  const tTitle = state.activeTask?.title;
  const readinessDescription = describeMilestoneReadinessPhase(state.phase);
  if (readinessDescription) return readinessDescription;

  switch (state.phase) {
    case "planning":
      return { label: `Plan ${sid}: ${sTitle}`, description: "Research and decompose into tasks." };
    case "executing":
      return { label: `Execute ${tid}: ${tTitle}`, description: "Run the next task in a fresh session." };
    case "summarizing":
      return { label: `Complete ${sid}: ${sTitle}`, description: "Write summary, UAT, and merge to main." };
    case "replanning-slice":
      return { label: `Replan ${sid}: ${sTitle}`, description: "Blocker found — replan the slice." };
    case "completing-milestone":
      return { label: "Complete milestone", description: "Write milestone summary." };
    case "evaluating-gates":
      return { label: `Evaluate gates for ${sid}: ${sTitle}`, description: "Parallel quality gate assessment before execution." };
    default:
      return { label: "Continue", description: "Execute the next step." };
  }
}

// ─── Elapsed Time Formatting ──────────────────────────────────────────────────

/** Format elapsed time since auto-mode started */
export function formatAutoElapsed(autoStartTime: number): string {
  if (!autoStartTime || autoStartTime <= 0 || !Number.isFinite(autoStartTime)) return "";
  const ms = Date.now() - autoStartTime;
  if (ms < 0 || ms > 30 * 24 * 3600_000) return ""; // negative or >30 days = invalid
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** Format token counts for compact display */
export function formatWidgetTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatRuntimeHealthSignal(
  record: AutoUnitRuntimeRecord | null,
  now = Date.now(),
): { level: "green" | "yellow"; state: "recovering" | "waiting"; summary: string; detail?: string } | null {
  if (!record) return null;
  const idleMs = Math.max(0, now - record.lastProgressAt);
  const idleMinutes = Math.floor(idleMs / 60_000);
  if ((record.recoveryAttempts ?? 0) > 0 || record.phase === "recovered" || record.lastProgressKind.includes("recovery")) {
    return {
      level: "yellow",
      state: "recovering",
      summary: "Recovering",
      detail: `retry ${record.recoveryAttempts ?? 1} after ${record.lastRecoveryReason ?? "idle"} stall`,
    };
  }
  if (record.progressCount === 0 && idleMs >= 60_000) {
    return {
      level: "yellow",
      state: "waiting",
      summary: `provider idle ${idleMinutes}m`,
      detail: `last output ${idleMinutes}m ago`,
    };
  }
  return null;
}

export function shouldRenderRoadmapProgress(
  progress: { total: number; activeSliceTasks?: { total: number } | null } | null,
): progress is { total: number; activeSliceTasks?: { total: number } | null } {
  return !!progress && progress.total > 0;
}

function widgetGridLabel(theme: Theme, text: string, color: ThemeColor = "borderAccent"): string {
  return theme.fg(color, theme.bold(text.toUpperCase()));
}

function widgetGridColumn(content: string, width: number): string {
  return padRightVisible(truncateToWidth(content, width, "…"), width);
}

function widgetGridColumns(theme: Theme, width: number, parts: string[]): string {
  if (parts.length === 0) return "";
  const gap = theme.fg("dim", " │ ");
  const gapWidth = visibleWidth(gap) * (parts.length - 1);
  const available = Math.max(parts.length * 8, width - gapWidth);
  const base = Math.floor(available / parts.length);
  let remaining = available - base * parts.length;
  const columns = parts.map((part) => {
    const columnWidth = base + (remaining > 0 ? 1 : 0);
    remaining--;
    return widgetGridColumn(part, columnWidth);
  });
  return truncateToWidth(columns.join(gap), width, "…");
}

function formatSmallWidgetSpend(): string {
  const ledger = getLedger();
  if (!ledger || ledger.units.length === 0) return "--";

  const totals = getProjectTotals(ledger.units);
  const parts: string[] = [];
  if (totals.tokens.total > 0) parts.push(formatWidgetTokens(totals.tokens.total));
  if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : "--";
}

// ─── ETA Estimation ──────────────────────────────────────────────────────────

/**
 * Estimate remaining time based on average unit duration from the metrics ledger.
 * Returns a formatted string like "~12m remaining" or null if insufficient data.
 */
export function estimateTimeRemaining(): string | null {
  const ledger = getLedger();
  if (!ledger || ledger.units.length < 2) return null;

  const sliceProgress = getRoadmapSlicesSync();
  if (!sliceProgress || sliceProgress.total === 0) return null;

  const remainingSlices = sliceProgress.total - sliceProgress.done;
  if (remainingSlices <= 0) return null;

  // Compute average duration per completed slice from the ledger
  const completedSliceUnits = filterUnitsForMilestone(ledger.units, sliceProgress.milestoneId).filter(
    u => u.finishedAt > 0 && u.startedAt > 0,
  );
  if (completedSliceUnits.length < 2) return null;

  const totalDuration = completedSliceUnits.reduce(
    (sum, u) => sum + (u.finishedAt - u.startedAt), 0,
  );
  const avgDuration = totalDuration / completedSliceUnits.length;

  // Rough estimate: remaining slices × average units per slice × avg duration
  const completedSlices = sliceProgress.done || 1;
  const unitsPerSlice = completedSliceUnits.length / completedSlices;
  const estimatedMs = remainingSlices * unitsPerSlice * avgDuration;

  if (estimatedMs < 5_000) return null; // Too small to display

  const s = Math.floor(estimatedMs / 1000);
  if (s < 60) return `~${s}s remaining`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m remaining`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `~${h}h ${rm}m remaining` : `~${h}h remaining`;
}

// ─── Slice Progress Cache ─────────────────────────────────────────────────────

/** Cached task detail for the widget task checklist */
interface CachedTaskDetail {
  id: string;
  title: string;
  done: boolean;
}

/** Cached slice progress for the widget — avoid async in render */
let cachedSliceProgress: {
  done: number;
  total: number;
  milestoneId: string;
  /** Real task progress for the active slice, if its plan file exists */
  activeSliceTasks: { done: number; total: number } | null;
  /** Full task list for the active slice checklist */
  taskDetails: CachedTaskDetail[] | null;
} | null = null;

export function updateSliceProgressCache(base: string, mid: string, activeSid?: string): void {
  try {
    // Normalize slices: prefer DB, fall back to parser
    type NormSlice = { id: string; done: boolean; title: string };
    let normSlices: NormSlice[];
    if (isDbAvailable()) {
      normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete", title: s.title }));
    } else {
      normSlices = [];
    }

    let activeSliceTasks: { done: number; total: number } | null = null;
    let taskDetails: CachedTaskDetail[] | null = null;
    if (activeSid) {
      try {
        if (isDbAvailable()) {
          const dbTasks = getSliceTasks(mid, activeSid);
          if (dbTasks.length > 0) {
            activeSliceTasks = {
              done: dbTasks.filter(t => t.status === "complete" || t.status === "done").length,
              total: dbTasks.length,
            };
            taskDetails = dbTasks.map(t => ({ id: t.id, title: t.title, done: t.status === "complete" || t.status === "done" }));
          }
        }
      } catch (err) {
        // Non-fatal — just omit task count
        logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    cachedSliceProgress = {
      done: normSlices.filter(s => s.done).length,
      total: normSlices.length,
      milestoneId: mid,
      activeSliceTasks,
      taskDetails,
    };
  } catch (err) {
    // Non-fatal — widget just won't show progress bar
    logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function getRoadmapSlicesSync(): { done: number; total: number; milestoneId: string; activeSliceTasks: { done: number; total: number } | null; taskDetails: CachedTaskDetail[] | null } | null {
  return cachedSliceProgress;
}

export function clearSliceProgressCache(): void {
  cachedSliceProgress = null;
}

// ─── Last Commit Cache ────────────────────────────────────────────────────────

/** Cached last commit info — refreshed on the 15s timer, not every render */
let cachedLastCommit: { timeAgo: string; message: string } | null = null;
let lastCommitFetchedAt = 0;

function refreshLastCommit(basePath: string): void {
  try {
    if (!nativeIsRepo(basePath)) {
      cachedLastCommit = null;
      return;
    }
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000,
      });
    } catch {
      cachedLastCommit = null;
      return;
    }
    const raw = execFileSync("git", ["log", "-1", "--format=%cr|%s"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    const sep = raw.indexOf("|");
    if (sep > 0) {
      cachedLastCommit = {
        timeAgo: raw.slice(0, sep).replace(/ ago$/, ""),
        message: raw.slice(sep + 1),
      };
    }
  } catch (err) {
    // Non-fatal — just skip last commit display
    cachedLastCommit = null;
    logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lastCommitFetchedAt = Date.now();
  }
}

function getLastCommit(basePath: string): { timeAgo: string; message: string } | null {
  // Refresh at most every 15 seconds
  if (Date.now() - lastCommitFetchedAt > 15_000) {
    refreshLastCommit(basePath);
  }
  return cachedLastCommit;
}

export function _resetLastCommitCacheForTests(): void {
  cachedLastCommit = null;
  lastCommitFetchedAt = 0;
}

export function _refreshLastCommitForTests(basePath: string): void {
  refreshLastCommit(basePath);
}

export function _getLastCommitForTests(basePath: string): { timeAgo: string; message: string } | null {
  return getLastCommit(basePath);
}

export function _getLastCommitFetchedAtForTests(): number {
  return lastCommitFetchedAt;
}

// ─── Footer Factory ───────────────────────────────────────────────────────────

/**
 * Footer factory used by auto-mode.
 * Keep footer minimal but preserve extension status context from setStatus().
 */
function sanitizeFooterStatus(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const hideFooter = (_tui: unknown, theme: Theme, footerData: ReadonlyFooterDataProvider) => ({
  render(width: number): string[] {
    const extensionStatuses = footerData.getExtensionStatuses();
    if (extensionStatuses.size === 0) return [];
    const statusLine = Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeFooterStatus(text))
      .join(" ");
    return [truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "..."))];
  },
  invalidate() {},
  dispose() {},
});

// ─── Widget Display Mode ──────────────────────────────────────────────────────

/** Widget display modes: full → small → min → off → full */
export type WidgetMode = "full" | "small" | "min" | "off";
export const DEFAULT_WIDGET_MODE: WidgetMode = "small";
const WIDGET_MODES: WidgetMode[] = ["full", "small", "min", "off"];
let widgetMode: WidgetMode = DEFAULT_WIDGET_MODE;
let widgetModeInitialized = false;
let widgetModePreferencePath: string | null = null;

function safeReadTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readWidgetModeFromFile(path: string): WidgetMode | undefined {
  const raw = safeReadTextFile(path);
  if (!raw) return undefined;
  const prefs = parsePreferencesMarkdown(raw);
  const saved = prefs?.widget_mode;
  if (saved && WIDGET_MODES.includes(saved as WidgetMode)) {
    return saved as WidgetMode;
  }
  return undefined;
}

function resolveWidgetModePreferencePath(
  projectPath = getProjectGSDPreferencesPath(),
  globalPath = getGlobalGSDPreferencesPath(),
): string {
  if (readWidgetModeFromFile(projectPath)) {
    return projectPath;
  }

  if (readWidgetModeFromFile(globalPath)) {
    return globalPath;
  }

  if (safeReadTextFile(projectPath) !== null) return projectPath;
  if (safeReadTextFile(globalPath) !== null) return globalPath;
  return getGlobalGSDPreferencesPath();
}

/** Load widget mode from preferences (once). */
function ensureWidgetModeLoaded(projectPath?: string, globalPath?: string): void {
  if (widgetModeInitialized) return;
  widgetModeInitialized = true;
  try {
    const resolvedProjectPath = projectPath ?? getProjectGSDPreferencesPath();
    const resolvedGlobalPath = globalPath ?? getGlobalGSDPreferencesPath();
    const saved = readWidgetModeFromFile(resolvedProjectPath) ?? readWidgetModeFromFile(resolvedGlobalPath);
    if (saved && WIDGET_MODES.includes(saved as WidgetMode)) {
      widgetMode = saved as WidgetMode;
    }
    widgetModePreferencePath = resolveWidgetModePreferencePath(resolvedProjectPath, resolvedGlobalPath);
  } catch (err) { /* non-fatal — use default */
    logWarning("dashboard", `operation failed: ${getErrorMessage(err)}`);
    widgetModePreferencePath = getGlobalGSDPreferencesPath();
  }
}

/**
 * Persist widget mode to the preference file that owns the effective value.
 * Project-scoped widget_mode wins over global; if neither scope defines it,
 * we prefer an existing project preferences file and otherwise fall back to
 * the global preferences file.
 */
function persistWidgetMode(
  mode: WidgetMode,
  prefsPath = widgetModePreferencePath ?? resolveWidgetModePreferencePath(),
): void {
  try {
    let content = "";
    if (existsSync(prefsPath)) {
      content = readFileSync(prefsPath, "utf-8");
    }
    const line = `widget_mode: ${mode}`;
    const re = /^widget_mode:\s*\S+/m;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = content.trimEnd() + "\n" + line + "\n";
    }
    writeFileSync(prefsPath, content, "utf-8");
  } catch (err) { /* non-fatal — mode still set in memory */
    logWarning("dashboard", `file write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Cycle to the next widget mode. Returns the new mode. */
export function cycleWidgetMode(projectPath?: string, globalPath?: string): WidgetMode {
  ensureWidgetModeLoaded(projectPath, globalPath);
  const idx = WIDGET_MODES.indexOf(widgetMode);
  widgetMode = WIDGET_MODES[(idx + 1) % WIDGET_MODES.length];
  persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(projectPath, globalPath));
  return widgetMode;
}

/** Set widget mode directly. */
export function setWidgetMode(mode: WidgetMode, projectPath?: string, globalPath?: string): void {
  ensureWidgetModeLoaded(projectPath, globalPath);
  widgetMode = mode;
  persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(projectPath, globalPath));
}

/** Get current widget mode. */
export function getWidgetMode(projectPath?: string, globalPath?: string): WidgetMode {
  ensureWidgetModeLoaded(projectPath, globalPath);
  return widgetMode;
}

/** Test-only reset for widget mode caching. */
export function _resetWidgetModeForTests(): void {
  widgetMode = DEFAULT_WIDGET_MODE;
  widgetModeInitialized = false;
  widgetModePreferencePath = null;
}

// ─── Progress Widget ──────────────────────────────────────────────────────────

/** State accessors passed to updateProgressWidget to avoid direct global access */
export interface WidgetStateAccessors {
  getAutoStartTime(): number;
  isStepMode(): boolean;
  getCmdCtx(): ExtensionCommandContext | null;
  getBasePath(): string;
  isVerbose(): boolean;
  /** True while newSession() is in-flight — render must not access session state. */
  isSessionSwitching(): boolean;
  /** Fully-qualified dispatched model ID (provider/id) set after model selection + hook overrides (#2899). */
  getCurrentDispatchedModelId(): string | null;
}

function clearAutoOutcomeWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("gsd-outcome", undefined);
}

export function setAutoActiveStatus(ctx: ExtensionContext, status: "auto" | "next"): void {
  ctx.ui.setStatus("gsd-auto", status);
  clearAutoOutcomeWidget(ctx);
}

export function updateProgressWidget(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  state: GSDState,
  accessors: WidgetStateAccessors,
): void {
  if (!ctx.hasUI) return;

  // Welcome header is a startup-only banner — permanently suppress it once
  // auto-mode activates. The dashboard widget owns all status from here.
  // Note: setHeader(undefined) restores the built-in header (logo +
  // instructions). To actually render zero lines, install an empty header.
  if (typeof ctx.ui?.setHeader === "function") {
    ctx.ui.setHeader(() => ({
      render(): string[] { return []; },
      invalidate(): void {},
    }));
  }
  // Clear wizard step badge — auto-mode owns the UI from this point
  if (typeof ctx.ui?.setStatus === "function") {
    ctx.ui.setStatus("gsd-step", undefined);
  }
  if (!accessors.isSessionSwitching()) {
    clearAutoOutcomeWidget(ctx);
  }

  const verb = unitVerb(unitType);
  const phaseLabel = unitPhaseLabel(unitType);
  const mid = state.activeMilestone;
  const isHook = unitType.startsWith("hook/");

  // When run-uat is executing for a just-completed slice (e.g. S01),
  // deriveState() has already advanced activeSlice to the next one (S02).
  // Override the displayed slice to match the UAT target from the unit ID.
  const uatTargetSliceId = unitType === "run-uat" ? extractUatSliceId(unitId) : null;
  const slice = uatTargetSliceId
    ? { id: uatTargetSliceId, title: state.activeSlice?.title ?? "" }
    : state.activeSlice;
  const task = state.activeTask;

  if (mid) {
    updateSliceProgressCache(accessors.getBasePath(), mid.id, slice?.id);
  }

  installGsdProgressStrip(ctx, accessors, unitType, unitId, mid, slice, task, isHook, verb);
}

function buildCompletionRollupLines(
  theme: Theme,
  snapshot: CompletionDashboardSnapshot,
  width: number,
): { lines: string[]; footerCommands?: string } {
  const innerWidth = Math.max(8, width - 2);
  const lines: string[] = [];

  const add = (line: string): void => {
    if (!line) return;
    for (const wrapped of wrapVisibleText(line, innerWidth).slice(0, 12 - lines.length)) {
      lines.push(wrapped);
    }
  };

  if (snapshot.milestoneTitle) {
    add(theme.fg("text", snapshot.milestoneTitle));
  }

  const oneLiner = normalizeRollupText(snapshot.oneLiner);
  if (oneLiner) {
    add(`${theme.fg("accent", "Outcome")} ${theme.fg("text", oneLiner)}`);
  }

  const changed = [
    ...(snapshot.successCriteriaResults ? [snapshot.successCriteriaResults] : []),
    ...(snapshot.requirementOutcomes ? [snapshot.requirementOutcomes] : []),
    ...(snapshot.keyDecisions ?? []),
  ].map(normalizeRollupText).filter((v): v is string => !!v).slice(0, 4);
  if (changed.length > 0) {
    add(theme.fg("accent", "What changed"));
    for (const item of changed) add(`  - ${theme.fg("text", item)}`);
  }

  const verification = [
    snapshot.definitionOfDoneResults,
    snapshot.deviations ? `Deviations: ${snapshot.deviations}` : null,
    snapshot.followUps ? `Follow-ups: ${snapshot.followUps}` : null,
  ].map(normalizeRollupText).filter((v): v is string => !!v);
  if (verification.length > 0 || (snapshot.keyFiles?.length ?? 0) > 0) {
    add(theme.fg("accent", "Verification"));
    for (const item of verification.slice(0, 3)) add(`  - ${theme.fg("text", item)}`);
    const files = (snapshot.keyFiles ?? []).map(normalizeRollupText).filter((v): v is string => !!v).slice(0, 4);
    if (files.length > 0) {
      add(`  ${theme.fg("accent", "Files:")} ${theme.fg("text", files.join("; "))}`);
    }
  }

  const lessons = (snapshot.lessonsLearned ?? []).map(normalizeRollupText).filter((v): v is string => !!v).slice(0, 2);
  if (lessons.length > 0) {
    add(`${theme.fg("accent", "Lessons:")} ${theme.fg("text", lessons.join("; "))}`);
  }

  const nextAction = snapshot.allMilestonesComplete
    ? snapshot.unmappedActiveRequirements && snapshot.unmappedActiveRequirements > 0
      ? `Review ${snapshot.unmappedActiveRequirements} unmapped active requirement${snapshot.unmappedActiveRequirements === 1 ? "" : "s"}, then start a new milestone when ready.`
      : "Review the roll-up, then start a new milestone when ready."
    : "Review the roll-up, inspect status, or continue to the next milestone.";
  add(`${theme.fg("success", "Next")} ${theme.fg("text", nextAction)}`);

  if ((snapshot.requirementsBacklogPreview?.length ?? 0) > 0) {
    add(theme.fg("accent", "Requirements backlog"));
    for (const line of snapshot.requirementsBacklogPreview ?? []) {
      add(`  ${theme.fg("text", line)}`);
    }
  }

  const commands = snapshot.allMilestonesComplete
    ? snapshot.unmappedActiveRequirements && snapshot.unmappedActiveRequirements > 0
      ? ["/gsd to review requirements backlog", "/gsd status for overview", "/gsd visualize to inspect", "/gsd start for new work"]
      : ["/gsd status for overview", "/gsd visualize to inspect", "/gsd notifications for history", "/gsd start for new work"]
    : ["/gsd status for overview", "/gsd visualize to inspect", "/gsd notifications for history", "/gsd auto for next milestone"];
  const footerCommands = theme.fg("dim", commands.join("  ·  "));

  if (snapshot.reason) {
    add(theme.fg("dim", snapshot.reason));
  }

  return { lines, footerCommands };
}

export function setCompletionProgressWidget(
  ctx: ExtensionContext,
  snapshot: CompletionDashboardSnapshot,
): void {
  if (!ctx.hasUI) return;
  clearAutoOutcomeWidget(ctx);
  // Clear the structured GSD progress strip so it does not linger behind
  // the completion widget (the two use separate display channels).
  ctx.ui?.setGsdProgress?.(undefined);
  ctx.ui.setWidget("gsd-progress", undefined);

  if (typeof ctx.ui?.setHeader === "function") {
    ctx.ui.setHeader(() => ({
      render(): string[] { return []; },
      invalidate(): void {},
    }));
  }
  if (typeof ctx.ui?.setStatus === "function") {
    ctx.ui.setStatus("gsd-step", undefined);
  }

  ctx.ui.setWidget("gsd-outcome", (_tui, theme) => ({
    render(width: number): string[] {
      const elapsed = formatAutoElapsed(snapshot.startedAt);
      const heading = snapshot.allMilestonesComplete
        ? "All milestones complete"
        : snapshot.milestoneId
          ? `Milestone ${snapshot.milestoneId} roll-up`
          : "Milestone roll-up";
      const statusLine = `${theme.fg("success", "✓")} ${theme.fg("text", heading)}`;
      const { lines, footerCommands } = buildCompletionRollupLines(theme, snapshot, width);
      return renderPlainOutcome(theme, width, statusLine, lines, {
        headerRight: elapsed ? theme.fg("dim", elapsed) : undefined,
        footerRight: footerCommands,
      });
    },
    invalidate(): void {},
    dispose(): void {},
  }));
}

export function setAutoOutcomeWidget(
  ctx: ExtensionContext,
  snapshot: AutoOutcomeSurfaceSnapshot,
): void {
  if (!ctx.hasUI) return;
  ctx.ui?.setGsdProgress?.(undefined);
  ctx.ui.setWidget("gsd-progress", undefined);

  ctx.ui.setWidget("gsd-outcome", (_tui, theme) => ({
    render(width: number): string[] {
      const color = snapshot.status === "failed" || snapshot.status === "blocked"
        ? "warning"
        : snapshot.status === "complete"
          ? "success"
          : "borderAccent";
      const icon = snapshot.status === "complete" ? "✓"
        : snapshot.status === "failed" ? "x"
          : snapshot.status === "blocked" ? "!"
            : snapshot.status === "paused" ? "||"
              : "●";
      const elapsed = snapshot.startedAt ? formatAutoElapsed(snapshot.startedAt) : "";
      const statusLine = `${theme.fg(color, icon)} ${theme.fg("text", snapshot.title)}`;
      const commands = snapshot.commands?.filter(Boolean) ?? [];
      const commandLine = commands.length > 0 ? theme.fg("dim", commands.join("  ·  ")) : undefined;

      const innerWidth = Math.max(8, width);
      const maxLines = 7;
      const splitRows: Array<{ left: string; right?: string }> = [];
      let commandsPlaced = false;

      const pushLeft = (left: string): void => {
        if (splitRows.length >= maxLines - (commandLine ? 1 : 0)) return;
        splitRows.push({ left });
      };

      if (snapshot.detail) {
        for (const line of wrapVisibleText(snapshot.detail, innerWidth).slice(0, maxLines)) {
          pushLeft(theme.fg("text", line));
        }
      }

      if (snapshot.unitLabel) {
        const lastLeft = theme.fg("dim", "Last · ") + theme.fg("text", snapshot.unitLabel);
        if (
          commandLine &&
          visibleWidth(lastLeft) + visibleWidth(commandLine) + 2 <= innerWidth &&
          splitRows.length < maxLines
        ) {
          splitRows.push({ left: lastLeft, right: commandLine });
          commandsPlaced = true;
        } else {
          pushLeft(lastLeft);
        }
      }

      const nextPrefix = theme.fg("success", "Next · ");
      const nextPrefixWidth = visibleWidth(nextPrefix);
      for (const [idx, line] of wrapVisibleText(
        snapshot.nextAction,
        Math.max(8, innerWidth - nextPrefixWidth),
      ).entries()) {
        if (splitRows.length >= maxLines - (commandLine && !commandsPlaced ? 1 : 0)) break;
        const lead = idx === 0 ? nextPrefix : " ".repeat(nextPrefixWidth);
        pushLeft(theme.fg("text", lead + line));
      }

      return renderPlainOutcome(theme, width, statusLine, [], {
        headerRight: elapsed ? theme.fg("dim", elapsed) : undefined,
        splitRows,
        footerRight: commandLine && !commandsPlaced ? commandLine : undefined,
      });
    },
    invalidate(): void {},
    dispose(): void {},
  }));
}

function normalizeRollupText(value: string | null | undefined): string | null {
  const clean = value
    ?.replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .trim();
  if (!clean || clean === "(none)" || clean === "None." || clean === "Not provided.") return null;
  return clean;
}

function isAssistantMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.role === "assistant") return true;

  const message = record.message;
  if (message && typeof message === "object") {
    return (message as Record<string, unknown>).role === "assistant";
  }

  return false;
}

function extractLastAssistantSummary(messages: unknown[] | null | undefined): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isAssistantMessage(messages[i])) continue;
    const text = extractMessageText(messages[i]);
    const clean = normalizeRollupText(text);
    if (clean) return truncateToWidth(clean, 220, "…");
  }
  return null;
}

function extractMessageText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;

  const message = record.message;
  if (message && typeof message === "object") {
    return extractMessageText(message);
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const partRecord = part as Record<string, unknown>;
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  }

  return null;
}

type MilestoneRef = NonNullable<GSDState["activeMilestone"]>;
type SliceRef = NonNullable<GSDState["activeSlice"]>;
type TaskRef = NonNullable<GSDState["activeTask"]>;

function buildGsdProgressPayload(
  accessors: WidgetStateAccessors,
  unitType: string,
  unitId: string,
  mid: MilestoneRef | null | undefined,
  slice: SliceRef | null | undefined,
  task: TaskRef | null | undefined,
  isHook: boolean,
  verb: string,
  runtimeRecord: AutoUnitRuntimeRecord | null,
): GsdProgressState | undefined {
  const mode = getWidgetMode();
  if (mode === "off") return undefined;

  const elapsed = formatAutoElapsed(accessors.getAutoStartTime());
  const eta = estimateTimeRemaining();
  const etaShort = eta ? eta.replace(" remaining", " left") : undefined;
  const modeTag = accessors.isStepMode() ? "NEXT" : "AUTO";

  const target = task
    ? `${task.id}: ${task.title}`
    : slice
      ? `${slice.id}: ${slice.title}`
      : unitId;
  const phase = `${verb} ${target}`.trim();

  const roadmapSlices = mid ? getRoadmapSlicesSync() : null;
  let taskProgress: { done: number; total: number } | undefined;
  let sliceProgress: { done: number; total: number } | undefined;
  if (shouldRenderRoadmapProgress(roadmapSlices)) {
    if (roadmapSlices.total > 0) {
      sliceProgress = { done: roadmapSlices.done, total: roadmapSlices.total };
    }
    const { activeSliceTasks } = roadmapSlices;
    if (activeSliceTasks && activeSliceTasks.total > 0) {
      const taskNum = isHook
        ? Math.max(activeSliceTasks.done, 1)
        : Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
      taskProgress = { done: taskNum, total: activeSliceTasks.total };
    }
  }

  const runtimeSignal = formatRuntimeHealthSignal(runtimeRecord);
  const score = computeProgressScore();
  let healthSummary: string | undefined;
  if (mode !== "min") {
    if (runtimeSignal?.detail) {
      healthSummary = runtimeSignal.detail;
    } else if (score.level !== "green") {
      healthSummary = score.signals
        .filter((signal) => signal.kind === "negative")
        .slice(0, 2)
        .map((signal) => signal.label)
        .join(" · ");
    }
  }

  const unitLabel = unitId || [mid?.id, slice?.id, task?.id].filter(Boolean).join("/");

  return {
    phase,
    modeTag,
    taskProgress,
    sliceProgress,
    sliceLabel: slice?.id,
    taskLabel: task?.id,
    unitLabel,
    elapsed,
    eta: etaShort,
    model: accessors.getCurrentDispatchedModelId() ?? undefined,
    healthSummary,
    path: accessors.getBasePath(),
    widgetMode: mode,
  };
}

function installGsdProgressStrip(
  ctx: ExtensionContext,
  accessors: WidgetStateAccessors,
  unitType: string,
  unitId: string,
  mid: MilestoneRef | null | undefined,
  slice: SliceRef | null | undefined,
  task: TaskRef | null | undefined,
  isHook: boolean,
  verb: string,
): void {
  if (!ctx.hasUI || typeof ctx.ui?.setGsdProgress !== "function") return;

  ctx.ui.setWidget("gsd-progress", undefined);

  let cachedRuntimeRecord: AutoUnitRuntimeRecord | null = null;
  const refreshRuntimeRecord = (): void => {
    try {
      cachedRuntimeRecord = readUnitRuntimeRecord(accessors.getBasePath(), unitType, unitId);
    } catch {
      cachedRuntimeRecord = null;
    }
  };
  refreshRuntimeRecord();

  let progressRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let elapsedRefreshTimer: ReturnType<typeof setInterval> | undefined;

  const dispose = (): void => {
    if (progressRefreshTimer !== undefined) {
      clearInterval(progressRefreshTimer);
      progressRefreshTimer = undefined;
    }
    if (elapsedRefreshTimer !== undefined) {
      clearInterval(elapsedRefreshTimer);
      elapsedRefreshTimer = undefined;
    }
    // Do not call setGsdProgress here: callers (resetExtensionUI, unit transition,
    // setCompletionProgressWidget) clear gsdProgressState directly, and calling it
    // here would re-enter setGsdProgress which calls dispose again — infinite recursion.
  };

  const publish = (registerDispose = false): boolean => {
    if (accessors.isSessionSwitching()) {
      // On initial install (registerDispose) clear any stale strip from the
      // previous unit. On timer refreshes, skip silently — calling
      // setGsdProgress(undefined) would run dispose() and permanently clear
      // the refresh timers, leaving the strip blank after the switch.
      if (registerDispose) {
        ctx.ui!.setGsdProgress!(undefined);
      }
      return false;
    }
    ctx.ui!.setGsdProgress!(
      buildGsdProgressPayload(
        accessors,
        unitType,
        unitId,
        mid,
        slice,
        task,
        isHook,
        verb,
        cachedRuntimeRecord,
      ),
      registerDispose ? dispose : undefined,
    );
    return true;
  };

  const startElapsedRefreshTimer = (): void => {
    if (elapsedRefreshTimer !== undefined) return;
    elapsedRefreshTimer = setInterval(() => {
      try {
        publish();
      } catch (err) {
        logWarning("dashboard", `progress strip elapsed refresh failed: ${getErrorMessage(err)}`);
      }
    }, 1_000);
    elapsedRefreshTimer.unref?.();
  };

  const startProgressRefreshTimer = (): void => {
    if (progressRefreshTimer !== undefined) return;
    progressRefreshTimer = setInterval(() => {
      try {
        if (mid) {
          updateSliceProgressCache(accessors.getBasePath(), mid.id, slice?.id);
        }
        refreshRuntimeRecord();
        publish();
      } catch (err) {
        logWarning("dashboard", `progress strip refresh failed: ${getErrorMessage(err)}`);
      }
    }, 15_000);
    progressRefreshTimer.unref?.();
  };

  if (publish(true)) {
    startElapsedRefreshTimer();
    startProgressRefreshTimer();
  }
}
