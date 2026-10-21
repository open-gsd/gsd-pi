// Project/App: gsd-pi
// File Purpose: Registers read-only DB query tools.
// gsd-pi — Read-only query tools exposing DB state to the LLM via the WAL connection

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { ensureDbOpen, resolveCtxCwd } from "./dynamic-tools.js";
import { checkpointWorkflowDatabase } from "../db-workspace.js";
import { autoSession } from "../auto-runtime-state.js";
import { getGuidedUnitContext } from "../guided-unit-context.js";
import {
  classifyMilestoneStatusRuntimeMode,
} from "../milestone-status-observation-context.js";
import type { MilestoneStatusObservationContext } from "../lifecycle-shadow-observation.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { resolveUokFlags } from "../uok/flags.js";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.js";
import { resolveWorkflowMcpProjectRoot } from "../workflow-mcp.js";

type SourceRevisionCapture = typeof captureMilestoneVerificationSourceRevision;

interface NativeSourceRevision {
  sourceRevision: string;
  contextError?: "unavailable";
}

interface QueryToolDependencies {
  captureMilestoneVerificationSourceRevision?: SourceRevisionCapture;
}

const nativeSourceRevisions = new Map<string, NativeSourceRevision>();

function nativeSourceRevisionKey(basePath: string, sessionId: string): string {
  return `${resolveWorkflowMcpProjectRoot(basePath)}\0${sessionId}`;
}

export function clearNativeMilestoneStatusSourceRevisions(): void {
  nativeSourceRevisions.clear();
}

function captureNativeMilestoneStatusSourceRevision(
  basePath: string,
  sessionId: string,
  captureSourceRevision: SourceRevisionCapture,
): NativeSourceRevision | undefined {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return undefined;
  const key = nativeSourceRevisionKey(basePath, normalizedSessionId);
  const cached = nativeSourceRevisions.get(key);
  if (cached) return cached;

  let sourceRevision = "unavailable";
  let contextError: "unavailable" | undefined;
  try {
    const preferences = loadEffectiveGSDPreferences(basePath)?.preferences;
    const captured = captureSourceRevision(basePath, preferences);
    if (captured.ok) sourceRevision = captured.sourceRevision;
    else contextError = "unavailable";
  } catch {
    contextError = "unavailable";
  }
  const result: NativeSourceRevision = {
    sourceRevision,
    ...(contextError ? { contextError } : {}),
  };
  nativeSourceRevisions.set(key, result);
  return result;
}

function contextSessionId(ctx: unknown): string | undefined {
  try {
    if (!ctx || typeof ctx !== "object") return undefined;
    const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
    if (typeof sessionManager?.getSessionId !== "function") return undefined;
    const sessionId = sessionManager.getSessionId();
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function nativeMilestoneStatusContext(
  basePath: string,
  toolCallId: string,
  sessionId: string | undefined,
  captureSourceRevision: SourceRevisionCapture,
): MilestoneStatusObservationContext {
  let uok: ReturnType<typeof resolveUokFlags> | undefined;
  let contextError: "unavailable" | undefined;
  let guidedActive = false;
  try {
    const preferences = loadEffectiveGSDPreferences(basePath)?.preferences;
    uok = resolveUokFlags(preferences);
    guidedActive = getGuidedUnitContext(basePath) !== null;
  } catch {
    contextError = "unavailable";
  }
  const preparedSource = sessionId
    ? captureNativeMilestoneStatusSourceRevision(basePath, sessionId, captureSourceRevision)
    : undefined;
  const sourceRevision = preparedSource?.sourceRevision ?? "unavailable";
  if (!preparedSource || preparedSource.contextError) contextError = "unavailable";
  const projectRoot = resolveWorkflowMcpProjectRoot(basePath);
  const autoActive = autoSession.active && [autoSession.originalBasePath, autoSession.basePath]
    .some((candidate) => candidate && resolveWorkflowMcpProjectRoot(candidate) === projectRoot);
  const turnId = autoActive ? autoSession.currentTurnId ?? sessionId : sessionId;
  return {
    mode: classifyMilestoneStatusRuntimeMode({
      autoActive,
      activeEngineId: autoActive ? autoSession.activeEngineId : null,
      uokEnabled: uok?.enabled,
      uokLegacyFallback: uok?.legacyFallback,
      guidedActive,
    }),
    transport: "native_pi",
    sourceRevision,
    traceId: autoActive ? autoSession.currentTraceId ?? toolCallId : toolCallId,
    ...(turnId ? { turnId } : {}),
    ...(contextError ? { contextError } : {}),
  };
}

export function registerQueryTools(
  pi: ExtensionAPI,
  dependencies: QueryToolDependencies = {},
): void {
  const captureSourceRevision = dependencies.captureMilestoneVerificationSourceRevision
    ?? captureMilestoneVerificationSourceRevision;
  pi.registerTool({
    name: "gsd_milestone_status",
    label: "Milestone Status",
    description:
      "Read the current status of a milestone and all its slices from the GSD database. " +
      "Returns milestone metadata (including `dependsOn`, the persisted milestone dependencies), " +
      "per-slice status, and task counts per slice. " +
      "Use this instead of querying .gsd/gsd.db directly via sqlite3 or better-sqlite3.",
    promptSnippet: "Get milestone status, slice statuses, and task counts for a given milestoneId",
    promptGuidelines: [
      "Use this tool — not sqlite3 or better-sqlite3 — to inspect milestone or slice state from the DB.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to query (e.g. M001)" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const basePath = resolveCtxCwd(ctx);
      const { executeMilestoneStatus } = await import("../tools/workflow-tool-executors.js");
      const sessionId = contextSessionId(ctx);
      const result = await executeMilestoneStatus(
        params,
        basePath,
        nativeMilestoneStatusContext(basePath, toolCallId, sessionId, captureSourceRevision),
      );
      if (result.details?.error === "db_unavailable") {
        return {
          content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot read milestone status." }],
          details: { operation: "milestone_status", error: "db_unavailable" },
        };
      }
      return result;
    },
  });

  pi.registerTool({
    name: "gsd_checkpoint_db",
    label: "Checkpoint GSD Database",
    description:
      "Flush the SQLite WAL (Write-Ahead Log) into the base gsd.db file. " +
      "Call this before `git add .gsd/gsd.db` to ensure the committed database " +
      "contains current milestone/slice/task state rather than stale pre-session content. " +
      "Safe to call at any time while GSD is running.",
    promptSnippet: "Flush WAL into gsd.db so git add stages current state",
    promptGuidelines: [
      "Call gsd_checkpoint_db immediately before staging .gsd/gsd.db with git add.",
      "Do not use sqlite3 or shell commands to checkpoint — they are blocked. Use this tool instead.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const dbAvailable = await ensureDbOpen(resolveCtxCwd(_ctx));
      if (!dbAvailable) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot checkpoint." }],
          details: { operation: "checkpoint_db", error: "db_unavailable" },
        };
      }
      checkpointWorkflowDatabase();
      return {
        content: [{ type: "text", text: "WAL checkpoint complete. gsd.db is now up to date and safe to stage with git add." }],
        details: { operation: "checkpoint_db", status: "ok" },
      };
    },
  });
}
