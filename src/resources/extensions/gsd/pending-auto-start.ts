// gsd-pi — Pending auto-start handoff state.
// Stores discuss-to-auto handoff entries keyed by project root. The durable
// part (milestone, flags, start time, session) is a discussion_handoffs row;
// the map holds the same entry bound to the live session handles.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { isDbAvailable } from "./gsd-db.js";
import {
  deleteDiscussionHandoffRows,
  readDiscussionHandoffRow,
  writeDiscussionHandoffRow,
} from "./db/writers/runtime-control.js";
import { logWarning } from "./workflow-logger.js";
import { createWorkspace, scopeMilestone, type MilestoneScope } from "./workspace.js";

export interface PendingAutoStartEntry {
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  basePath: string;
  milestoneId: string;
  step?: boolean;
  startAuto?: boolean;
  createdAt: number;
  readyRejectCount?: number;
  scope: MilestoneScope;
  r3bRecoveryCount: number;
}

export interface PendingAutoStartInput {
  basePath: string;
  milestoneId: string;
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  step?: boolean;
  startAuto?: boolean;
  createdAt?: number;
}

const pendingAutoStartMap = new Map<string, PendingAutoStartEntry>();

export function getPendingAutoStart(basePath?: string): PendingAutoStartEntry | null {
  if (basePath) return pendingAutoStartMap.get(basePath) ?? null;
  if (pendingAutoStartMap.size === 1) return pendingAutoStartMap.values().next().value!;
  return null;
}

export const _getPendingAutoStart = getPendingAutoStart;

export function hasPendingAutoStart(basePath?: string): boolean {
  if (basePath) return pendingAutoStartMap.has(basePath);
  return pendingAutoStartMap.size > 0;
}

function sessionIdOf(ctx: ExtensionCommandContext): string | null {
  return ctx.sessionManager?.getSessionId?.() ?? null;
}

function flag(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function bindPendingAutoStart(basePath: string, entry: PendingAutoStartInput & { createdAt: number }): void {
  const ws = createWorkspace(entry.basePath);
  const scope = scopeMilestone(ws, entry.milestoneId);
  pendingAutoStartMap.set(basePath, {
    r3bRecoveryCount: 0,
    ...entry,
    scope,
    ctx: entry.ctx,
    pi: entry.pi,
  });
}

export function setPendingAutoStart(basePath: string, entry: PendingAutoStartInput): void {
  if (!entry.ctx || !entry.pi) {
    throw new Error("setPendingAutoStart requires ctx and pi");
  }
  const createdAt = entry.createdAt ?? Date.now();
  bindPendingAutoStart(basePath, { ...entry, createdAt });
  if (!isDbAvailable()) return;
  try {
    writeDiscussionHandoffRow({
      base_path: basePath,
      milestone_id: entry.milestoneId,
      step: flag(entry.step),
      start_auto: flag(entry.startAuto),
      session_id: sessionIdOf(entry.ctx),
      created_at: createdAt,
    });
  } catch (err) {
    // The bound entry still completes the handoff in this process.
    logWarning("guided", `discuss handoff row was not saved: ${(err as Error).message}`);
  }
}

/**
 * Bind the handoff row that an earlier process saved to the handles of the
 * current command. Returns true when an entry was restored. A row of another
 * conversation is deleted: its interview cannot be answered here.
 */
export function restorePendingAutoStart(
  basePath: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): boolean {
  if (pendingAutoStartMap.has(basePath)) return false;
  const row = readDiscussionHandoffRow(basePath);
  if (!row) return false;
  if (row.session_id !== sessionIdOf(ctx)) {
    deleteDiscussionHandoffRows(basePath);
    return false;
  }
  bindPendingAutoStart(basePath, {
    ctx,
    pi,
    basePath,
    milestoneId: row.milestone_id,
    ...(row.step === null ? {} : { step: row.step === 1 }),
    ...(row.start_auto === null ? {} : { startAuto: row.start_auto === 1 }),
    createdAt: row.created_at,
  });
  return true;
}

export function deletePendingAutoStart(basePath: string): void {
  pendingAutoStartMap.delete(basePath);
  deleteDiscussionHandoffRows(basePath);
}

export function clearPendingAutoStart(basePath?: string): void {
  if (basePath) {
    pendingAutoStartMap.delete(basePath);
  } else {
    pendingAutoStartMap.clear();
  }
  deleteDiscussionHandoffRows(basePath);
}

export function getDiscussionMilestoneId(basePath?: string): string | null {
  if (basePath) {
    return pendingAutoStartMap.get(basePath)?.milestoneId ?? null;
  }
  if (pendingAutoStartMap.size === 1) {
    return pendingAutoStartMap.values().next().value!.milestoneId;
  }
  return null;
}
