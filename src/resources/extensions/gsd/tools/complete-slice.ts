// Project/App: gsd-pi
// File Purpose: Complete-slice tool handler for GSD workflow state and summaries.

/**
 * complete-slice handler — the core operation behind gsd_slice_complete.
 *
 * Normalizes transport input, publishes evidence-backed Slice lifecycle and
 * closeout facts in one Domain Operation, then renders Markdown projections
 * from the durable receipt. Projection failures never roll back authority.
 */

import { join } from "node:path";

import type { CompleteSliceParams } from "../types.js";
import { getDb } from "../gsd-db.js";
import { clearPathCache, relSliceFile } from "../paths.js";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import { checkOwnership, sliceUnitKey } from "../unit-ownership.js";
import { loadFile, saveFile, clearParseCache } from "../files.js";
import { classifyUatContent, escalatesArtifactUatToBrowser } from "../uat-policy.js";
import { invalidateStateCache } from "../state.js";
import { renderMilestoneShellProjections } from "../workflow-projections.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { removeProjectionFileSync } from "../atomic-write.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import {
  completeSlice,
  isCurrentSliceCompletionOperation,
  SliceLifecycleValidationError,
  type SliceCompletionCloseout,
} from "../slice-lifecycle-domain-operation.js";
import { setSliceCompletionSummaryProjectionIfCurrent } from "../db/writers/slice-lifecycle.js";

export interface CompleteSliceResult {
  sliceId: string;
  milestoneId: string;
  summaryPath: string;
  uatPath: string;
  /**
   * True when this exact invocation replayed its durable operation receipt.
   */
  duplicate?: boolean;
  /** True when the receipt is no longer the current Slice lifecycle head. */
  superseded?: boolean;
  stale?: boolean;
}

function sliceSummaryPath(basePath: string, milestoneId: string, sliceId: string): string {
  // Layout-aware: flat-phase projects use NN-MM-SUMMARY.md inside the phase dir;
  // legacy projects use milestones/MID/slices/SID/SID-SUMMARY.md.
  // relSliceFile returns a path relative to basePath (e.g. ".gsd/phases/01-test/01-01-SUMMARY.md"),
  // so join with basePath (not gsdProjectionRoot which would double the ".gsd/" segment).
  return join(basePath, relSliceFile(basePath, milestoneId, sliceId, "SUMMARY"));
}

async function removeOwnedProjection(path: string, content: string): Promise<void> {
  if (await loadFile(path) !== content) return;
  try {
    removeProjectionFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Render slice summary markdown matching the template format.
 * YAML frontmatter uses snake_case keys for parseSummary() compatibility.
 */
function renderSliceSummaryMarkdown(params: CompleteSliceParams, completedAt: string): string {

  // Apply defaults for optional enrichment arrays (#2771)
  const provides = params.provides ?? [];
  const requires = params.requires ?? [];
  const affects = params.affects ?? [];
  const keyFiles = params.keyFiles ?? [];
  const keyDecisions = params.keyDecisions ?? [];
  const patternsEstablished = params.patternsEstablished ?? [];
  const observabilitySurfaces = params.observabilitySurfaces ?? [];
  const drillDownPaths = params.drillDownPaths ?? [];
  const requirementsAdvanced = params.requirementsAdvanced ?? [];
  const requirementsValidated = params.requirementsValidated ?? [];
  const requirementsSurfaced = params.requirementsSurfaced ?? [];
  const requirementsInvalidated = params.requirementsInvalidated ?? [];
  const filesModified = params.filesModified ?? [];

  const providesYaml = provides.length > 0
    ? provides.map(p => `  - ${p}`).join("\n")
    : "  - (none)";

  const requiresYaml = requires.length > 0
    ? requires.map(r => `  - slice: ${r.slice}\n    provides: ${r.provides}`).join("\n")
    : "  []";

  const affectsYaml = affects.length > 0
    ? affects.map(a => `  - ${a}`).join("\n")
    : "  []";

  const keyFilesYaml = keyFiles.length > 0
    ? `\n${keyFiles.map(f => `  - ${f}`).join("\n")}`
    : " []";

  const keyDecisionsYaml = keyDecisions.length > 0
    ? `\n${keyDecisions.map(d => `  - ${d}`).join("\n")}`
    : " []";

  const patternsYaml = patternsEstablished.length > 0
    ? patternsEstablished.map(p => `  - ${p}`).join("\n")
    : "  - (none)";

  const observabilityYaml = observabilitySurfaces.length > 0
    ? observabilitySurfaces.map(o => `  - ${o}`).join("\n")
    : "  - none";

  const drillDownYaml = drillDownPaths.length > 0
    ? drillDownPaths.map(d => `  - ${d}`).join("\n")
    : "  []";

  // Requirements sections
  const reqAdvanced = requirementsAdvanced.length > 0
    ? requirementsAdvanced.map(r => `- ${r.id} — ${r.how}`).join("\n")
    : "None.";

  const reqValidated = requirementsValidated.length > 0
    ? requirementsValidated.map(r => `- ${r.id} — ${r.proof}`).join("\n")
    : "None.";

  const reqSurfaced = requirementsSurfaced.length > 0
    ? requirementsSurfaced.map(r => `- ${r}`).join("\n")
    : "None.";

  const reqInvalidated = requirementsInvalidated.length > 0
    ? requirementsInvalidated.map(r => `- ${r.id} — ${r.what}`).join("\n")
    : "None.";

  // Files modified
  const filesMod = filesModified.length > 0
    ? filesModified.map(f => `- \`${f.path}\` — ${f.description}`).join("\n")
    : "None.";

  return `---
id: ${params.sliceId}
parent: ${params.milestoneId}
milestone: ${params.milestoneId}
provides:
${providesYaml}
requires:
${requiresYaml}
affects:
${affectsYaml}
key_files:${keyFilesYaml}
key_decisions:${keyDecisionsYaml}
patterns_established:
${patternsYaml}
observability_surfaces:
${observabilityYaml}
drill_down_paths:
${drillDownYaml}
duration: ""
verification_result: passed
completed_at: ${completedAt}
blocker_discovered: false
---

# ${params.sliceId}: ${params.sliceTitle}

**${params.oneLiner}**

## What Happened

${params.narrative}

## Verification

${params.verification ?? ""}

## Requirements Advanced

${reqAdvanced}

## Requirements Validated

${reqValidated}

## New Requirements Surfaced

${reqSurfaced}

## Requirements Invalidated or Re-scoped

${reqInvalidated}

## Operational Readiness

${params.operationalReadiness?.trim() || "None."}

## Deviations

${params.deviations || "None."}

## Known Limitations

${params.knownLimitations || "None."}

## Follow-ups

${params.followUps || "None."}

## Files Created/Modified

${filesMod}
`;
}

/**
 * Render UAT markdown matching the template format.
 */
function renderUatMarkdown(params: CompleteSliceParams, completedAt: string): string {
  return `# ${params.sliceId}: ${params.sliceTitle} — UAT

**Milestone:** ${params.milestoneId}
**Written:** ${completedAt}

${params.uatContent}
`;
}

function readPriorCloseout(
  params: Pick<CompleteSliceParams, "milestoneId" | "sliceId">,
  invocation: ExecutionInvocation,
): SliceCompletionCloseout | undefined {
  const query = (where: string, bindings: Record<string, string>) => getDb().prepare(`
    SELECT event.payload_json
    FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE event.event_type = 'slice.completed'
      AND event.entity_type = 'slice'
      AND event.entity_id = :entity_id
      AND ${where}
    ORDER BY event.project_revision DESC
    LIMIT 1
  `).get({
    ":entity_id": `${params.milestoneId}/${params.sliceId}`,
    ...bindings,
  }) as Record<string, unknown> | undefined;
  const row = query(
    "operation.idempotency_key = :idempotency_key",
    { ":idempotency_key": invocation.idempotencyKey },
  ) ?? query("1 = 1", {});
  if (!row) return undefined;
  const payload = JSON.parse(String(row["payload_json"])) as { closeout?: SliceCompletionCloseout };
  return payload.closeout;
}

function normalizeCloseout(
  params: CompleteSliceParams,
  prior?: SliceCompletionCloseout,
): SliceCompletionCloseout {
  return {
    sliceTitle: params.sliceTitle,
    oneLiner: params.oneLiner,
    narrative: params.narrative,
    verification: params.verification ?? "",
    uatContent: params.uatContent,
    operationalReadiness: params.operationalReadiness ?? "",
    deviations: params.deviations ?? "None.",
    knownLimitations: params.knownLimitations ?? "None.",
    followUps: params.followUps ?? "None.",
    provides: params.provides ?? prior?.provides ?? [],
    requires: params.requires ?? prior?.requires ?? [],
    affects: params.affects ?? prior?.affects ?? [],
    keyFiles: params.keyFiles ?? prior?.keyFiles ?? [],
    keyDecisions: params.keyDecisions ?? prior?.keyDecisions ?? [],
    patternsEstablished: params.patternsEstablished ?? prior?.patternsEstablished ?? [],
    observabilitySurfaces: params.observabilitySurfaces ?? prior?.observabilitySurfaces ?? [],
    drillDownPaths: params.drillDownPaths ?? prior?.drillDownPaths ?? [],
    requirementsAdvanced: params.requirementsAdvanced ?? prior?.requirementsAdvanced ?? [],
    requirementsValidated: params.requirementsValidated ?? prior?.requirementsValidated ?? [],
    requirementsSurfaced: params.requirementsSurfaced ?? prior?.requirementsSurfaced ?? [],
    requirementsInvalidated: params.requirementsInvalidated ?? prior?.requirementsInvalidated ?? [],
    filesModified: params.filesModified ?? prior?.filesModified ?? [],
  };
}

/**
 * Handle the complete_slice operation end-to-end.
 *
 * 1. Validate required fields
 * 2. Normalize closeout facts
 * 3. Publish evidence-backed Slice completion atomically
 * 4. Render SUMMARY.md, UAT.md, roadmap, and state after commit
 */
export async function handleCompleteSlice(
  params: CompleteSliceParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<CompleteSliceResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);

  // ── Ownership check (opt-in: only enforced when claim file exists) ──────
  const ownershipErr = checkOwnership(
    artifactBasePath,
    sliceUnitKey(params.milestoneId, params.sliceId),
    params.actorName,
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }

  // ── Verification content gate (#3580) ──────────────────────────────────
  // Reject completion when the provided verification/UAT clearly indicates
  // the slice is blocked or failed. Prevents prompt regressions from
  // silently advancing blocked slices.
  const BLOCKED_SIGNALS = /\b(status:\s*blocked|verification_result:\s*failed|slice is blocked|cannot complete|verification failed)\b/i;
  if (BLOCKED_SIGNALS.test(params.verification || "") || BLOCKED_SIGNALS.test(params.uatContent || "")) {
    return { error: `slice verification indicates blocked/failed state — do not complete a slice that has not passed verification. Address the blockers and re-verify first.` };
  }

  // ── Browser/web UAT classification gate ────────────────────────────────
  // A UAT that drives a running web UI (opening a page in a browser,
  // navigating to a page/localhost) must declare a browser-capable mode so the
  // run-uat runner surfaces browser tools and actually launches a browser.
  // Otherwise the browser checks get silently deferred to a human and the slice
  // passes on static checks alone (M001/S03 regression). `browser-executable`,
  // `live-runtime`, and `mixed` all receive browser tools (see
  // UAT_MODE_POLICIES); only the non-browser modes are rejected here.
  //
  // Reuse the canonical hasBrowserRequiredText detector (also used by dispatch
  // and milestone validation): it skips Not-Proven/Out-of-Scope disclaimer
  // sections and only treats verbs like navigate/open as web when they sit next
  // to browser/page/localhost — avoiding false positives on CLI/file/API steps.
  //
  // Only `artifact-driven` is gated. It is the one mode that performs no
  // execution at all (static/file checks), so a browser-requiring UAT under it
  // genuinely defers verification to a human. Every other mode has a real
  // verification path: `runtime-executable` runs browser test commands like
  // `npx playwright test` via gsd_uat_exec, and live-runtime/mixed/
  // browser-executable receive browser tools (UAT_MODE_POLICIES).
  const uatContent = params.uatContent || "";
  const uatPolicy = classifyUatContent(uatContent);
  if (escalatesArtifactUatToBrowser(uatPolicy)) {
    // Distinguish an explicit artifact-driven declaration from a missing or
    // unparseable one that merely *defaulted* to artifact-driven — telling an
    // agent it "declared artifact-driven" when its declaration simply failed
    // to parse sends it into a rewrite loop with the same unparseable format.
    const staticOnlyClause = `which only runs static/file checks and would defer the browser work to a human`;
    const modeClause = uatPolicy.modeDeclared
      ? `declares "UAT mode: artifact-driven", ${staticOnlyClause}`
      : `has no parseable UAT mode declaration in its "## UAT Type" section (the declaration must be a bullet exactly like "- UAT mode: browser-executable"), so it defaults to "artifact-driven", ${staticOnlyClause}`;
    return {
      error: `UAT requires browser verification (opening a page in a browser, navigating to a page or localhost, screenshots) but ${modeClause}. Use a mode that actually verifies the UI: "browser-executable" (interactive browser tools), "runtime-executable" (a browser test command such as playwright), or a browser-inclusive "mixed"/"live-runtime". Re-author the UAT Type section and complete the slice again.`,
    };
  }

  const closeout = normalizeCloseout(params, readPriorCloseout(params, invocation));
  let completion: ReturnType<typeof completeSlice>;
  try {
    completion = completeSlice({
      invocation,
      slice: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      closeout,
      audit: { actorName: params.actorName, triggerReason: params.triggerReason },
    });
  } catch (error) {
    if (!(error instanceof SliceLifecycleValidationError)) throw error;
    return { error: error.message };
  }

  const duplicateComplete = completion.status === "replayed";
  const summaryPath = sliceSummaryPath(
    artifactBasePath,
    params.milestoneId,
    params.sliceId,
  );
  const uatPath = summaryPath.replace(/-SUMMARY\.md$/, "-UAT.md");
  if (!completion.isCurrent) {
    return {
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      summaryPath,
      uatPath,
      ...(duplicateComplete ? { duplicate: true } : {}),
      superseded: true,
    };
  }
  const effectiveParams: CompleteSliceParams = {
    ...completion.closeout,
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
  };
  const summaryMd = renderSliceSummaryMarkdown(effectiveParams, completion.completedAt);

  // Resolve and write summary to disk
  const uatMd = renderUatMarkdown(effectiveParams, completion.completedAt);
  let projectionStale = false;
  let superseded = false;
  const slice = { milestoneId: params.milestoneId, sliceId: params.sliceId };
  function isCurrent(): boolean {
    return isCurrentSliceCompletionOperation(completion.operationId, slice);
  }

  try {
    if (!setSliceCompletionSummaryProjectionIfCurrent({
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      operationId: completion.operationId,
      summaryMd,
      uatMd,
    })) {
      superseded = true;
      projectionStale = true;
    } else {
      await saveFile(summaryPath, summaryMd);
      if (isCurrent()) {
        await saveFile(uatPath, uatMd);
      }
      if (!isCurrent()) {
        superseded = true;
        projectionStale = true;
        await removeOwnedProjection(summaryPath, summaryMd);
        await removeOwnedProjection(uatPath, uatMd);
      }
    }
  } catch (renderErr) {
    projectionStale = true;
    logWarning("projection", `complete_slice projection write failed for ${params.milestoneId}/${params.sliceId}; DB completion remains committed`, { error: (renderErr as Error).message });
  }

  // Invalidate all caches
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  // ── Post-mutation hook: projections, manifest, event log ───────────────
  // Separate try/catch per step so a projection failure doesn't prevent
  // the event log entry (critical for worktree reconciliation).
  try {
    if (superseded || !isCurrent()) {
      superseded = true;
      projectionStale = true;
    } else {
      const rendered = await renderMilestoneShellProjections(artifactBasePath, params.milestoneId);
      projectionStale ||= rendered.stale;
      if (!isCurrent()) {
        superseded = true;
        projectionStale = true;
      }
    }
  } catch (projErr) {
    projectionStale = true;
    logWarning("tool", `complete-slice projection warning for ${params.milestoneId}/${params.sliceId}: ${(projErr as Error).message}`);
  }
  if (!superseded) {
    try {
      await writeManifestAndFlush(artifactBasePath);
    } catch (mfErr) {
      logWarning("tool", `complete-slice manifest warning: ${(mfErr as Error).message}`);
    }
  }
  if (completion.status === "committed") {
    try {
      appendEvent(artifactBasePath, {
        cmd: "complete-slice",
        params: { milestoneId: params.milestoneId, sliceId: params.sliceId },
        ts: completion.completedAt,
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (eventErr) {
      logWarning("tool", "complete-slice compatibility event warning", { error: (eventErr as Error).message });
    }
  }

  if (!isCurrent()) {
    superseded = true;
    projectionStale = true;
    try {
      await removeOwnedProjection(summaryPath, summaryMd);
      await removeOwnedProjection(uatPath, uatMd);
    } catch (cleanupErr) {
      logWarning("projection", `complete_slice stale projection cleanup failed for ${params.milestoneId}/${params.sliceId}`, { error: (cleanupErr as Error).message });
    }
  }

  // Fire-and-forget graph rebuild — must NOT await, must NOT crash slice completion.
  // Dynamic import of the package name (not a relative path) so it resolves
  // correctly via package.json#exports in both development and production.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  if (!superseded) {
    (async () => {
      try {
        const graphMod = await import("@opengsd/mcp-server") as unknown as Partial<{
          buildGraph: (dir: string) => Promise<{ nodes: unknown[]; edges: unknown[]; builtAt: string }>;
          writeGraph: (gsdRoot: string, graph: unknown) => Promise<void>;
          resolveGsdRoot: (basePath: string) => string;
        }>;
        if (
          typeof graphMod.buildGraph !== "function"
          || typeof graphMod.writeGraph !== "function"
          || typeof graphMod.resolveGsdRoot !== "function"
        ) {
          throw new Error("graph helpers unavailable from @opengsd/mcp-server");
        }
        const g = await graphMod.buildGraph(artifactBasePath);
        await graphMod.writeGraph(graphMod.resolveGsdRoot(artifactBasePath), g);
      } catch (graphErr) {
        // Graph rebuild is best-effort — log at warning level but never propagate
        logWarning("tool", `complete-slice graph rebuild failed (non-fatal): ${(graphErr as Error).message ?? String(graphErr)}`);
      }
    })();
  }

  return {
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
    uatPath,
    ...(duplicateComplete ? { duplicate: true } : {}),
    ...(superseded ? { superseded: true } : {}),
    ...(projectionStale ? { stale: true } : {}),
  };
}
