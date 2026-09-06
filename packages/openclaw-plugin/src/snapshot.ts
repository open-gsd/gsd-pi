/**
 * Compact project snapshot for chat (≤ 15 lines), same shape the Hermes
 * integration renders so both integrations read alike.
 */

import type { ProgressData, ProgressRef } from "./types.js";

export function formatRef(ref: ProgressRef | null | undefined, includeTitle = true): string {
  if (!ref) return "—";
  const id = ref.id ?? "";
  const title = ref.title ?? "";
  if (includeTitle && id && title && title !== id) return `${id}: ${title}`;
  return id || title || "—";
}

export function formatSnapshot(progress: ProgressData, extraLines: string[] = []): string {
  const lines: string[] = [
    "**GSD Project Snapshot**",
    `Phase: ${progress.phase ?? "unknown"}`,
    `Active milestone: ${formatRef(progress.activeMilestone)}`,
    `Active slice: ${formatRef(progress.activeSlice)}`,
    `Active task: ${formatRef(progress.activeTask)}`,
  ];
  const m = progress.milestones;
  if (m && (m.total ?? 0) > 0) {
    lines.push(`Milestones: ${m.done ?? 0}/${m.total} done (${m.active ?? 0} active)`);
  }
  const s = progress.slices;
  if (s && (s.total ?? 0) > 0) lines.push(`Slices: ${s.done ?? 0}/${s.total} done`);
  const t = progress.tasks;
  if (t && (t.total ?? 0) > 0) lines.push(`Tasks: ${t.done ?? 0}/${t.total} done`);
  const r = progress.requirements;
  if (r) lines.push(`Requirements: ${r.active ?? 0} active, ${r.validated ?? 0} validated`);
  if (progress.blockers?.length) {
    lines.push("Blockers:");
    for (const blocker of progress.blockers.slice(0, 3)) lines.push(`  - ${blocker}`);
  }
  if (progress.nextAction) lines.push(`Next: ${progress.nextAction}`);
  lines.push(...extraLines);
  return lines.slice(0, 15).join("\n");
}
