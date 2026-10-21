// Project/App: gsd-pi
// File Purpose: ADR-017 types for drift-driven state reconciliation.

import type { DeriveStateOptions } from "../state.js";
import type { GSDState } from "../types.js";

/**
 * Discriminated union over drift kinds the State Reconciliation Module
 * recognizes. Each variant carries the identifiers its matching repair needs.
 */
export type DriftRecord =
  | { kind: "stale-sketch-flag"; mid: string; sid: string }
  | { kind: "unmerged-merge-state"; basePath: string }
  | { kind: "stale-render"; renderPath: string; reason: string }
  | { kind: "stale-worker"; lockPath: string; pid: number }
  | { kind: "unregistered-milestone"; milestoneId: string }
  | { kind: "roadmap-divergence"; milestoneId: string; sliceId?: string }
  | { kind: "roadmap-missing"; milestoneId: string }
  | {
      kind: "disk-slice-id-divergence";
      milestoneId: string;
      sliceId: string;
      sliceDir: string;
      disposition: "delete-empty" | "quarantine-scaffold" | "block-meaningful";
      reason: string;
    }
  | {
      kind: "artifact-db-status-divergence";
      milestoneId: string;
      sliceId?: string;
      taskId?: string;
      artifactType: string;
      artifactPath?: string;
      dbStatus?: string;
      reason: string;
    }
  | {
      kind: "completed-milestone-reopened";
      milestoneId: string;
      dbStatus: string;
      completedDispatchAt?: string | null;
    }
  | {
      kind: "missing-completion-timestamp";
      entity: "task" | "slice" | "milestone";
      ids: string[];
    }
  | {
      kind: "external-markdown-edit";
      projectionPath: string;       // relative to basePath, e.g. "m1/plan.md"
      expectedSha: string;          // sha recorded in .compat.json
      actualSha: string;            // freshly computed from disk
      entities: string[];           // DB entity ids used to scope status authority
    }
  | {
      kind: "external-planning-edit";
      projectionPath: string;       // relative to .planning/, e.g. "phases/01-foo/01-01-PLAN.md"
      expectedSha: string;
      actualSha: string;
      entities: string[];           // DB entity ids used to scope status authority
      passthrough: boolean;         // true = content-only, no re-import, just refresh sha
    };

/**
 * Context threaded to detector and repair functions. Keeps handlers from
 * re-deriving state for themselves.
 */
export interface DriftContext {
  basePath: string;
  state: GSDState;
  /** When true, detectors must not persist compat marker changes. */
  dryRun?: boolean;
}

/**
 * One drift kind's detect+repair composition.
 *
 * Repairs MUST be idempotent: re-running yields the same outcome. This is
 * load-bearing for the cap=2 lifecycle — the second pass may detect drift
 * that the first pass already partially repaired.
 */
export interface DriftHandler<T extends DriftRecord = DriftRecord> {
  kind: T["kind"];
  detect: (state: GSDState, ctx: DriftContext) => T[] | Promise<T[]>;
  /**
   * Return a terminal blocker message for drift that is intentionally
   * non-repairable in runtime. This lets callers stop cleanly without
   * classifying the condition as a repair exception.
   */
  blocker?: (record: T, ctx: DriftContext) => string | null | Promise<string | null>;
  repair: (record: T, ctx: DriftContext) => Promise<void> | void;
}

/**
 * Result of a successful reconcileBeforeDispatch call.
 *
 * `blockers` are TERMINAL conditions (DB unavailable, slice lock invalid,
 * dependency cycle) that reconciliation cannot resolve. The caller decides
 * how to handle them; the orchestrator adapter at auto.ts maps non-empty
 * blockers to ok=false for the orchestrator's InvariantAdapterResult.
 *
 * On repair failure or drift persisting past the cap, reconcileBeforeDispatch
 * throws ReconciliationFailedError instead of returning.
 */
export interface ReconciliationResult {
  ok: true;
  stateSnapshot: GSDState;
  repaired: readonly DriftRecord[];
  blockers: readonly string[];
  blockerDetails: readonly ReconciliationBlockerDetail[];
}

/** Structured evidence retained for every terminal reconciliation blocker. */
export interface ReconciliationBlockerDetail {
  message: string;
  drift?: DriftRecord;
  detectorKind?: DriftRecord["kind"];
}

/**
 * Dependencies for reconcileBeforeDispatch. Tests inject fakes for the
 * registry and state derivation; production callers use defaults.
 */
export interface ReconciliationDeps {
  invalidateStateCache: () => void;
  deriveState: (
    basePath: string,
    opts?: DeriveStateOptions,
  ) => Promise<GSDState>;
  clearParseCache?: () => void;
  /**
   * Override of the drift handler catalog. Defaults to DRIFT_REGISTRY. Each
   * handler is parameterized over its own DriftRecord variant; the union of
   * disjoint parameter types in repair forces the array element type to
   * DriftHandler<any> here (see registry.ts comment).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry?: ReadonlyArray<DriftHandler<any>>;
  deriveStateOptions?: DeriveStateOptions;
  /** When true, detect drift but do not run repairs (read-only preview). */
  dryRun?: boolean;
}
