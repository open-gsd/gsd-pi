// Project/App: gsd-pi
// File Purpose: Pure diagnostics for native lifecycle adoption previews.

import type { LifecycleBackfillPreview } from "./lifecycle-backfill-domain-operation.js";

function formatPreviewIdentity(row: { milestoneId: string; sliceId: string | null; taskId: string | null }): string {
  return JSON.stringify([row.milestoneId, row.sliceId, row.taskId].filter((part) => part !== null).join("/"));
}

/** Describe existing adoption semantics without opening a database or granting authority. */
export function formatLifecycleBackfillPreview(preview: LifecycleBackfillPreview): string {
  const byRule = new Map<string, number>();
  for (const item of preview.items) {
    byRule.set(item.rule, (byRule.get(item.rule) ?? 0) + 1);
  }
  if (preview.waiverRepairs.length > 0) {
    byRule.set("adopted-cancelled-without-waiver", preview.waiverRepairs.length);
  }
  if (preview.unmarkedImportCompletions.length > 0) {
    byRule.set("import-adopted-completion", preview.unmarkedImportCompletions.length);
  }
  const changes = preview.items.filter((item) => item.projectedLegacyStatus !== null);
  const initialWaivers = preview.items.filter((item) => item.lifecycleStatus === "cancelled").length;
  const hasLegacyMarker = (item: LifecycleBackfillPreview["items"][number]) =>
    item.rule === "legacy-complete-evidenced" || item.rule === "legacy-complete-under-completed-parent";
  const initialMarkers = preview.items.filter(hasLegacyMarker).length;
  const lines = [
    "gsd db adopt preview:",
    `Initial adoptions: ${preview.items.length}; projected status changes: ${changes.length}`,
    `Initial effects: ${initialWaivers} cancelled-item Waivers; ${initialMarkers} unverified-legacy adoption markers`,
    `Existing-row repairs: ${preview.waiverRepairs.length} Waivers; ${preview.unmarkedImportCompletions.length} imported-completion markers`,
    ...[...byRule.entries()].map(([rule, count]) => `  ${rule}: ${count}`),
    changes.length > 0 ? "Projected status changes: included in rows below" : "Projected status changes: none",
    "Initial adoption rows:",
    ...preview.items.map((item) => {
      const planning = item.projectedLegacyStatus === null
        ? `${JSON.stringify(item.rawStatus)} (unchanged)`
        : `${JSON.stringify(item.rawStatus)} -> ${JSON.stringify(item.projectedLegacyStatus)}`;
      const effects = [
        ...(item.lifecycleStatus === "cancelled" ? ["Waiver"] : []),
        ...(hasLegacyMarker(item) ? ["unverified-legacy"] : []),
      ].join(", ") || "none";
      return `  ${item.itemKind} ${formatPreviewIdentity(item)}: ${planning}; canonical=${item.lifecycleStatus}; rule=${item.rule}; effects=${effects}`;
    }),
    ...(preview.waiverRepairs.length > 0 || preview.unmarkedImportCompletions.length > 0
      ? ["Existing-row repair targets:"]
      : []),
    ...preview.waiverRepairs.map((row) => `  Waiver repair: ${row.itemKind} ${formatPreviewIdentity(row)}`),
    ...preview.unmarkedImportCompletions.map((row) => `  Legacy-marker repair: ${row.itemKind} ${formatPreviewIdentity(row)}`),
    "Legacy adoption/import markers are not host Technical Verdicts and do not prove verification success.",
  ];
  if (changes.length > 0) {
    lines.push("Apply projects these legacy statuses; reopened completion timestamps are cleared. Reopened work can re-enter the queue under existing scheduling guards.");
  }
  if (preview.openUnderCompletedParent.length > 0) {
    lines.push(`Open work under a completed parent, adopted as cancelled:\n${
      preview.openUnderCompletedParent.map((entry) => `  ${JSON.stringify(entry.row)}: ${JSON.stringify(entry.rawStatus)}`).join("\n")
    }`);
  }
  lines.push("Run /gsd db adopt --apply to adopt them in one operation (a verified backup is written first).");
  return lines.join("\n");
}
