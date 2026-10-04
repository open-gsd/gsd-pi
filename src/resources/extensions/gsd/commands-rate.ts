/**
 * /gsd rate — Submit feedback on the last unit's model tier assignment.
 * Feeds into the adaptive routing history so future dispatches improve.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { loadLedgerFromDisk } from "./metrics.js";
import { clearRoutingHistory, recordFeedback, initRoutingHistory } from "./routing-history.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import type { ComplexityTier } from "./complexity-classifier.js";

const VALID_RATINGS = new Set(["over", "under", "ok"]);

export async function handleRate(
  args: string,
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<void> {
  const rating = args.trim().toLowerCase();

  if (rating === "reset") {
    if (!(await ensureDbOpen(basePath))) {
      ctx.ui.notify("Routing history not cleared: the project database could not be opened.", "error");
      return;
    }
    clearRoutingHistory();
    ctx.ui.notify("Routing history cleared. Adaptive routing starts again from no data.", "info");
    return;
  }

  if (!rating || !VALID_RATINGS.has(rating)) {
    ctx.ui.notify(
      "Usage: /gsd rate <over|ok|under|reset>\n" +
      "  over  — model was overpowered for that task (encourage cheaper)\n" +
      "  ok    — model was appropriate\n" +
      "  under — model was too weak (encourage stronger)\n" +
      "  reset — clear the routing history",
      "info",
    );
    return;
  }

  const ledger = loadLedgerFromDisk(basePath);
  if (!ledger || ledger.units.length === 0) {
    ctx.ui.notify("No completed units found — nothing to rate.", "warning");
    return;
  }

  const lastUnit = ledger.units[ledger.units.length - 1];
  const tier = lastUnit.tier as ComplexityTier | undefined;

  if (!tier) {
    ctx.ui.notify(
      "Last unit has no tier data (dynamic routing was not active). Rating skipped.",
      "warning",
    );
    return;
  }

  // The rating is stored in the project database; without one it would be lost.
  if (!(await ensureDbOpen(basePath))) {
    ctx.ui.notify("Rating not recorded: the project database could not be opened.", "error");
    return;
  }
  initRoutingHistory();
  recordFeedback(lastUnit.type, lastUnit.id, tier, rating as "over" | "under" | "ok");

  ctx.ui.notify(
    `Recorded "${rating}" for ${lastUnit.type}/${lastUnit.id} at tier ${tier}.`,
    "info",
  );
}
