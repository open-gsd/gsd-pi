// Project/App: gsd-pi
// File Purpose: Registers workspace-aware dynamic filesystem and shell tools.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import {
  getWorkflowDatabaseStatus,
  openWorkflowDatabaseIsolated,
  openWorkflowDatabase,
  resolveProjectRootDbPath,
  type WorkflowDatabaseOpenResult,
  type WorkflowDatabaseStatus,
} from "../db-workspace.js";
import { getAutoWorktreePath } from "../auto-worktree-path-resolution.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { worktreesDirs } from "../worktree-placement.js";
import { MIN_SQLITE_NODE_VERSION, supportsRequiredSqliteApi } from "../db-provider.js";

export function safeWorkspaceCwd(): string {
  try {
    return process.cwd();
  } catch {
    const projectRoot = process.env.GSD_PROJECT_ROOT;
    if (projectRoot && existsSync(projectRoot)) return projectRoot;
    return homedir();
  }
}

export function resolveCtxCwd(ctx?: unknown): string {
  if (ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string") {
    const cwd = (ctx as { cwd: string }).cwd;
    if (existsSync(cwd)) return cwd;
  }
  return safeWorkspaceCwd();
}

function activeWorktrees(projectRoot: string): string[] {
  const live: string[] = [];
  for (const worktreesDir of worktreesDirs(projectRoot)) {
    if (!existsSync(worktreesDir)) continue;
    try {
      live.push(...readdirSync(worktreesDir)
        .map((name) => join(worktreesDir, name))
        .filter((path) => existsSync(join(path, ".git"))));
    } catch (err) {
      logWarning(
        "bootstrap",
        `Failed to scan worktrees: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return live;
}

/**
 * Base path for workflow MCP tools. Mirrors packages/mcp-server parseWorkflowArgs:
 * route writes to `<project>/.gsd/worktrees/<milestoneId>/` when that worktree exists.
 */
export function resolveWorkflowToolBasePath(
  ctx?: unknown,
  scope?: { milestone_id?: string },
): string {
  const cwd = resolveCtxCwd(ctx);
  const projectRoot = resolveWorktreeProjectRoot(cwd);
  const milestoneId = scope?.milestone_id?.trim();
  if (milestoneId) {
    const worktree = getAutoWorktreePath(projectRoot, milestoneId);
    if (worktree) return worktree;
  } else {
    const live = activeWorktrees(projectRoot);
    if (live.length === 1) return live[0]!;
  }
  return cwd;
}

function recoveryActionMilestoneId(projectRoot: string, recoveryActionId: string): string | null {
  const database = openWorkflowDatabaseIsolated(resolveProjectRootDbPath(projectRoot));
  if (!database) return null;
  try {
    const row = database.prepare(`
      SELECT lifecycle.milestone_id
      FROM workflow_recovery_actions action
      JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.project_id = action.project_id
       AND lifecycle.lifecycle_id = action.lifecycle_id
      WHERE action.recovery_action_id = :recovery_action_id
    `).get({ ":recovery_action_id": recoveryActionId });
    return typeof row?.["milestone_id"] === "string" ? row["milestone_id"] : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function resolveTaskRecoveryResumeBasePath(
  ctx: unknown,
  recoveryActionId: string,
  resolveMilestoneId: (projectRoot: string, recoveryActionId: string) => string | null = recoveryActionMilestoneId,
): string {
  const cwd = resolveCtxCwd(ctx);
  const projectRoot = resolveWorktreeProjectRoot(cwd);
  const milestoneId = resolveMilestoneId(projectRoot, recoveryActionId);
  return (milestoneId ? getAutoWorktreePath(projectRoot, milestoneId) : null)
    ?? resolveWorkflowToolBasePath(ctx);
}

export { resolveProjectRootDbPath } from "../db-workspace.js";

type WorkflowDatabaseOpenFailure = Extract<WorkflowDatabaseOpenResult, { ok: false }>;

function sqliteProviderHint(status: WorkflowDatabaseStatus, nodeVersion: string): string {
  if (status.provider) return `Provider: ${status.provider}.`;

  if (!supportsRequiredSqliteApi(nodeVersion)) {
    return (
      `No SQLite provider available. Upgrade Node to >= ${MIN_SQLITE_NODE_VERSION} for node:sqlite ` +
      `(current: v${nodeVersion}) or use the packaged GSD runtime.`
    );
  }

  return (
    "No SQLite provider available. Use a Node build with node:sqlite enabled or run the packaged GSD runtime."
  );
}

function dbOpenPhaseHint(status: WorkflowDatabaseStatus): string {
  if (status.lastPhase === "locked") return "The database is locked by another process";
  if (status.lastPhase === "open") return "The database file could not be opened";
  if (status.lastPhase === "initSchema") return "The database schema could not be initialized";
  if (status.lastPhase === "vacuum-recovery") return "Corruption recovery (VACUUM) failed";
  if (status.attempted) return "The database could not be opened";
  return "The database provider could not be loaded";
}

export function formatWorkflowDatabaseOpenFailure(
  result: WorkflowDatabaseOpenFailure,
  status?: WorkflowDatabaseStatus,
  nodeVersion: string = process.versions.node,
): string {
  if (result.reason === "missing-gsd-dir") {
    return `ensureDbOpen failed — no .gsd directory found at ${result.location.projectGsd}`;
  }

  if (result.reason === "missing-database") {
    return `ensureDbOpen failed — no GSD database found at ${result.location.projectDb}`;
  }

  const resolvedStatus = status ?? getWorkflowDatabaseStatus();
  const detail = result.error?.message ?? resolvedStatus.lastError?.message ?? "";
  const detailSuffix = detail ? ` (${detail})` : "";
  return (
    `ensureDbOpen failed for ${result.location.projectDb}: ` +
    `${dbOpenPhaseHint(resolvedStatus)}${detailSuffix}. ${sqliteProviderHint(resolvedStatus, nodeVersion)}`
  );
}

export async function ensureDbOpen(basePath: string = safeWorkspaceCwd()): Promise<boolean> {
  const result = openWorkflowDatabase(basePath);
  if (result.ok) return true;

  logWarning("bootstrap", formatWorkflowDatabaseOpenFailure(result));
  return false;
}

export function registerDynamicTools(pi: ExtensionAPI): void {
  const fallbackRoot = safeWorkspaceCwd();
  const baseBash = createBashTool(fallbackRoot, {
    spawnHook: (ctx) => ctx,
  });
  // The auto-mode stalled-tool watchdog only exists in GSD/auto-mode, so the
  // watchdog verbiage is injected here (the GSD-registered tool) rather than in
  // core bash.ts, which is reused by non-GSD embeddings that have no watchdog.
  const WATCHDOG_DETAIL =
    "Genuine hangs are caught by the auto-mode stalled-tool watchdog (stalled: 5m / idle: 10m / soft: 20m / hard: 30m).";
  const gsdBashDescription = `${(baseBash as any).description} ${WATCHDOG_DETAIL}`;
  const gsdBashParameters = (() => {
    const params: any = (baseBash as any).parameters;
    if (!params?.properties?.timeout) return params;
    return {
      ...params,
      properties: {
        ...params.properties,
        timeout: {
          ...params.properties.timeout,
          description: `${params.properties.timeout.description} ${WATCHDOG_DETAIL}`,
        },
      },
    };
  })();
  const dynamicBash = {
    ...baseBash,
    description: gsdBashDescription,
    parameters: gsdBashParameters,
    execute: async (
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const basePath = resolveCtxCwd(ctx);
      const fresh = createBashTool(basePath, {
        spawnHook: (spawnCtx) => ({ ...spawnCtx, cwd: basePath }),
      });
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  pi.registerTool(dynamicBash as any);

  const baseWrite = createWriteTool(fallbackRoot);
  pi.registerTool({
    ...baseWrite,
    execute: async (
      toolCallId: string,
      params: { path: string; content: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const fresh = createWriteTool(resolveCtxCwd(ctx));
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as any);

  const baseRead = createReadTool(fallbackRoot);
  pi.registerTool({
    ...baseRead,
    execute: async (
      toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const fresh = createReadTool(resolveCtxCwd(ctx));
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as any);

  const baseEdit = createEditTool(fallbackRoot);
  pi.registerTool({
    ...baseEdit,
    execute: async (
      toolCallId: string,
      params: { path: string; oldText: string; newText: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const fresh = createEditTool(resolveCtxCwd(ctx));
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as any);
}
