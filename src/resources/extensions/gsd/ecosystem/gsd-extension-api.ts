// gsd-pi — Ecosystem Extension API wrapper
// Wraps pi's ExtensionAPI to expose typed GSD context (phase + active unit)
// to extensions loaded from `./.gsd/extensions/`. The wrapper intercepts only
// `on("before_agent_start", ...)` so GSD can dispatch ecosystem handlers AFTER
// refreshing state — fixing the load-order race where third-party
// `.pi/extensions/` handlers see a stale module-level snapshot (#3338).
//
// SINGLE-SESSION INVARIANT: the module-level `_snapshot` is per-process.
// Worktree or project switches do NOT reload extensions, matching pi's
// `.pi/extensions/` behavior. Only re-launching the CLI rebinds the snapshot.

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionHandler,
} from "@gsd/pi-coding-agent";

// Structural mirror of pi's internal BeforeAgentStartEventResult. The internal
// type is not re-exported from the package root, and constraint #3 forbids
// changes to packages/pi-coding-agent/, so we mirror the public shape here.
// `any` on inner fields keeps assignability bidirectional with pi's stricter
// `Pick<CustomMessage, ...>` shape (CustomMessage is also not re-exported).
// Source of truth: packages/pi-coding-agent/src/core/extensions/types.ts
export interface BeforeAgentStartEventResult {
  message?: {
    customType: string;
    content?: any;
    display?: any;
    details?: any;
  };
  systemPrompt?: string;
}

import type { DbProjectSnapshot } from "../state/project-snapshot.js";
import type { GSDActiveUnit, GSDState, Phase } from "../types.js";
import { isGSDActive, getCurrentPhase } from "../../shared/gsd-phase-state.js";
import { logWarning } from "../workflow-logger.js";

// ─── Public Interface ───────────────────────────────────────────────────

export interface GSDExtensionAPI extends ExtensionAPI {
  /** Current GSD workflow phase, or null if no project state. */
  getPhase(): Phase | null;
  /** Currently active milestone/slice/task triple, or null if none. */
  getActiveUnit(): GSDActiveUnit | null;
  /**
   * The project snapshot from the workflow database: authority revision,
   * current refs, progress counts, blockers, open questions, verification and
   * the milestone registry. Null when the project has no database. The read
   * changes nothing. An extension reads workflow state here and not from
   * `.gsd/` files, which are projections of the database.
   */
  getProjectSnapshot(basePath: string): Promise<DbProjectSnapshot | null>;
}

export type GSDEcosystemBeforeAgentStartHandler = ExtensionHandler<
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult
>;

// ─── Auto-loop phase mapping ────────────────────────────────────────────

const AUTO_LOOP_PHASE_MAP: Record<string, Phase> = {
  "plan-milestone": "planning",
  "plan-slice": "planning",
  "research": "researching",
  "discuss": "discussing",
  "execute-task": "executing",
  "verify": "verifying",
  "summarize-task": "summarizing",
  "summarize-slice": "summarizing",
  "advance": "advancing",
  "validate-milestone": "validating-milestone",
  "complete-milestone": "completing-milestone",
  "replan-slice": "replanning-slice",
};

/** Exposed for unit tests. Returns null for unknown keys (does NOT default). */
export function mapAutoLoopPhase(raw: string): Phase | null {
  return AUTO_LOOP_PHASE_MAP[raw] ?? null;
}

function resolvePhase(state: GSDState | null): Phase | null {
  if (!state) return null;
  if (isGSDActive()) {
    const raw = getCurrentPhase();
    if (raw != null) {
      const mapped = AUTO_LOOP_PHASE_MAP[raw];
      if (mapped) return mapped;
      logWarning("ecosystem", `unknown auto-loop phase: ${raw}`);
      // FALL THROUGH to state.phase rather than defaulting to "executing".
    }
  }
  return state.phase;
}

function resolveActiveUnit(state: GSDState | null): GSDActiveUnit | null {
  if (!state) return null;
  const m = state.activeMilestone;
  const s = state.activeSlice;
  const t = state.activeTask;
  if (!m || !s || !t) return null;
  return {
    milestoneId: m.id,
    milestoneTitle: m.title,
    sliceId: s.id,
    sliceTitle: s.title,
    taskId: t.id,
    taskTitle: t.title,
  };
}

// ─── Module-level snapshot ──────────────────────────────────────────────

interface Snapshot {
  phase: Phase | null;
  activeUnit: GSDActiveUnit | null;
}

let _snapshot: Snapshot = { phase: null, activeUnit: null };

/** Refresh the snapshot from a freshly derived GSDState (or null on failure). */
export function updateSnapshot(state: GSDState | null): void {
  _snapshot = {
    phase: resolvePhase(state),
    activeUnit: resolveActiveUnit(state),
  };
}

export function getSnapshotPhase(): Phase | null {
  return _snapshot.phase;
}

export function getSnapshotActiveUnit(): GSDActiveUnit | null {
  return _snapshot.activeUnit;
}

/** Test-only: reset the snapshot to its initial empty state. */
export function _resetSnapshot(): void {
  _snapshot = { phase: null, activeUnit: null };
}

// ─── Wrapper factory ────────────────────────────────────────────────────

/**
 * Build a GSDExtensionAPI that forwards to `pi`, except `on("before_agent_start")`
 * which is captured into `sharedHandlers` for GSD-owned dispatch.
 *
 * Proxy forwarding keeps the wrapper current as ExtensionAPI grows on the pin.
 */
export function createGSDExtensionAPI(
  pi: ExtensionAPI,
  sharedHandlers: GSDEcosystemBeforeAgentStartHandler[],
): GSDExtensionAPI {
  const gsdExtras = {
    getPhase: (): Phase | null => _snapshot.phase,
    getActiveUnit: (): GSDActiveUnit | null => _snapshot.activeUnit,
    getProjectSnapshot: async (basePath: string): Promise<DbProjectSnapshot | null> => {
      const { readProjectSnapshotFromDb } = await import("../state/project-snapshot.js");
      return readProjectSnapshotFromDb(basePath, { preserveGlobalDbHandle: true });
    },
  };

  const on: ExtensionAPI["on"] = ((event: any, handler: any) => {
    if (event === "before_agent_start") {
      sharedHandlers.push(handler as GSDEcosystemBeforeAgentStartHandler);
      return () => {
        const index = sharedHandlers.indexOf(handler as GSDEcosystemBeforeAgentStartHandler);
        if (index >= 0) sharedHandlers.splice(index, 1);
      };
    }
    return (pi.on as (e: any, h: any) => () => void)(event, handler);
  }) as ExtensionAPI["on"];

  return new Proxy(pi as object, {
    get(target, prop, receiver) {
      if (prop === "on") return on;
      if (prop in gsdExtras) {
        return gsdExtras[prop as keyof typeof gsdExtras];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as GSDExtensionAPI;
}
