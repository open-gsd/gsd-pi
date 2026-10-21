/**
 * GSD Command Handlers — fire-and-forget handlers that delegate to other modules.
 *
 * Contains: handleDoctor, handleSteer, handleCapture, handleTriage, handleKnowledge,
 * handleRunHook, handleUpdate, handleSkillHealth
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve as resolvePath, sep, win32 as pathWin32 } from "node:path";
import { homedir } from "node:os";
import { deriveState } from "./state.js";
import { gsdRoot } from "./paths.js";
import { gsdHome } from "./gsd-home.js";
import { appendCapture, hasPendingCaptures, loadPendingCaptures } from "./captures.js";
import { appendOverride, appendKnowledge } from "./files.js";
import {
  formatDoctorIssuesForPrompt,
  formatDoctorReport,
  formatDoctorReportJson,
  runGSDDoctor,
  selectDoctorScope,
  filterDoctorIssues,
} from "./doctor.js";
import { isAutoActive, checkRemoteAutoSession } from "./auto.js";
import { getAutoWorktreePath } from "./auto-worktree-path-resolution.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { currentDirectoryRoot, projectRoot } from "./commands/context.js";
import { loadPrompt } from "./prompt-loader.js";
import { buildClaudeRuntimeFloorAdvisory } from "../../shared/claude-runtime-floor.js";
import { reconcileGsdBrowserPathAfterInstall } from "../../shared/gsd-browser-path-sync.js";
import { isPnpmInstall } from "../../shared/package-manager-detection.js";
import {
  buildDoctorHealIssuePayload,
  buildDoctorHealSummary,
  buildWorkflowDispatchContent,
} from "./workflow-protocol.js";
import {
  restoreGsdWorkflowTools,
  scopeGsdWorkflowToolsForDispatch,
} from "./bootstrap/register-hooks.js";

const GSD_PI_PACKAGE = "@opengsd/gsd-pi";
const GSD_BROWSER_PACKAGE = "@opengsd/gsd-browser";
const UPDATE_REGISTRY_URL = "https://registry.npmjs.org/@opengsd%2fgsd-pi/latest";
const BROWSER_UPDATE_REGISTRY_URL = "https://registry.npmjs.org/@opengsd%2fgsd-browser/latest";
const UPDATE_FETCH_TIMEOUT_MS = 5000;

// Detects a bun-installed gsd via `process.argv[1]`. Mirrors isBunInstall in
// src/update-check.ts — duplicated because tsconfig.resources.json rootDir
// prevents importing from src/. See #4145 for why the runtime-only check
// (process.versions.bun) is insufficient: bun's global bin shims are plain
// symlinks, so the target's #!/usr/bin/env node shebang runs the script under
// Node even when it was installed by bun.
function isBunInstall(argv1: string | undefined = process.argv[1]): boolean {
  if ('bun' in process.versions) return true;
  if (!argv1) return false;
  const bunBinDirs: string[] = [];
  if (process.env.BUN_INSTALL) bunBinDirs.push(join(process.env.BUN_INSTALL, "bin"));
  bunBinDirs.push(join(homedir(), ".bun", "bin"));
  const resolved = resolvePath(argv1);
  return bunBinDirs.some((dir) => resolved.startsWith(resolvePath(dir) + sep));
}

function resolveInstallCommand(pkg: string): string {
  if (isBunInstall()) return `bun add -g ${pkg}`;
  if (isPnpmInstall()) return `pnpm add -g ${pkg}`;
  const npmPrefix = resolveWindowsNpmGlobalPrefix();
  if (npmPrefix) return `npm --prefix ${quoteWindowsArg(npmPrefix)} install -g ${pkg}`;
  return `npm install -g ${pkg}`;
}

function resolveWindowsNpmGlobalPrefix(
  argv1: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32" || !argv1) return null;
  const normalized = pathWin32.normalize(argv1);
  const marker = `${pathWin32.sep}node_modules${pathWin32.sep}`;
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index <= 0) return null;
  const prefix = normalized.slice(0, index);
  // Verify this is a real npm global prefix: such a directory always contains
  // npm's own bin shim (`npm.cmd`) as a sibling of `node_modules/`. Local
  // project `node_modules/`, npx caches, and other non-global layouts do not,
  // so without this check `--prefix` would target the wrong directory.
  if (!existsSync(pathWin32.join(prefix, "npm.cmd"))) return null;
  return prefix;
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function notifyClaudeRuntimeFloorAdvisory(ctx: ExtensionCommandContext): void {
  let advisory: string | null = null;
  try {
    advisory = buildClaudeRuntimeFloorAdvisory({
      agentDir: join(gsdHome(), "agent"),
      cwd: process.cwd(),
    });
  } catch {
    return;
  }
  if (advisory) {
    ctx.ui.notify(advisory, "warning");
  }
}

async function fetchLatestVersionForCommand(registryUrl: string = UPDATE_REGISTRY_URL): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(registryUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const latest = typeof data.version === "string" ? data.version.trim().replace(/^v/, "") : "";
    return latest.length > 0 ? latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveInstalledPackageVersionForCommand(packageName: string): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim().length > 0
      ? pkg.version.trim().replace(/^v/, "")
      : null;
  } catch {
    return null;
  }
}

export function dispatchDoctorHeal(pi: ExtensionAPI, scope: string | undefined, reportText: string, structuredIssues: string): void {
  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(gsdHome(), "agent", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");
  const prompt = loadPrompt("doctor-heal", {
    doctorSummary: buildDoctorHealSummary(reportText),
    structuredIssues: buildDoctorHealIssuePayload(structuredIssues),
    scopeLabel: scope ?? "active milestone / blocking scope",
    doctorCommandSuffix: scope ? ` ${scope}` : "",
  });

  const content = buildWorkflowDispatchContent({ workflow, workflowPath, task: prompt });
  const savedTools = scopeGsdWorkflowToolsForDispatch(pi);

  try {
    pi.sendMessage(
      { customType: "gsd-doctor-heal", content, display: false },
      { triggerTurn: true },
    );
  } finally {
    restoreGsdWorkflowTools(pi, savedTools);
  }
}

/** Parse doctor command args into structured flags and positionals (pure, no I/O). */
export function parseDoctorArgs(args: string) {
  const trimmed = args.trim();
  const jsonMode = trimmed.includes("--json");
  const dryRun = trimmed.includes("--dry-run");
  const fixFlag = trimmed.includes("--fix");
  const includeBuild = trimmed.includes("--build");
  const includeTests = trimmed.includes("--test");
  const stripped = trimmed.replace(/--json|--dry-run|--build|--test|--fix/g, "").trim();
  const parts = stripped ? stripped.split(/\s+/) : [];
  const mode = parts[0] === "fix" || parts[0] === "heal" || parts[0] === "audit" ? parts[0] : "doctor";
  const requestedScope = mode === "doctor" ? parts[0] : parts[1];
  return { jsonMode, dryRun, fixFlag, includeBuild, includeTests, mode, requestedScope };
}

export function isDoctorHealActionable(issue: { fixable: boolean; severity: string }): boolean {
  return issue.fixable && issue.severity !== "info";
}

/**
 * Compat-health line for `/gsd doctor`. Reports the gsd-core compat marker's
 * presence and the count of projection files whose on-disk sha has drifted
 * from the recorded baseline. Returns "" if the marker module is unavailable
 * (defensive — doctor must never fail because of compat reporting).
 *
 * Exported for unit testing.
 */
export async function formatCompatHealthLine(basePath: string): Promise<string> {
  try {
    const { readCompatMarker, computeProjectionSha } = await import("./compat/compat-marker.js");
    const marker = readCompatMarker(basePath);

    const countDrifted = (
      entries: Record<string, { sha: string }>,
      root: string,
    ): number => {
      let drifted = 0;
      for (const [rel, entry] of Object.entries(entries)) {
        const abs = join(basePath, root, rel);
        if (!existsSync(abs)) continue;
        if (computeProjectionSha(readFileSync(abs, "utf-8")) !== entry.sha) drifted++;
      }
      return drifted;
    };

    const lines: string[] = [];
    const gsdEntryCount = Object.keys(marker.projections).length;
    const planningActive = marker.planning?.active ?? false;
    const planningEntryCount = planningActive
      ? Object.keys(marker.planning!.projections).length +
        Object.keys(marker.planning!.passthrough).length
      : 0;

    if (gsdEntryCount === 0 && !planningActive) {
      return "  Compat health:      no baseline (run /gsd sync to establish)";
    }

    if (gsdEntryCount === 0) {
      lines.push("  Compat health (.gsd):    no baseline (run /gsd sync to establish)");
    } else {
      const gsdDrifted = countDrifted(marker.projections, ".gsd");
      lines.push(
        `  Compat health (.gsd):    ${gsdDrifted === 0 ? "OK" : `${gsdDrifted} file(s) drifted — run /gsd sync`}`,
      );
    }

    if (planningActive) {
      if (planningEntryCount === 0) {
        lines.push("  Compat health (.planning): no baseline (run /gsd sync to establish)");
      } else {
        const planningDrifted =
          countDrifted(marker.planning!.projections, ".planning") +
          countDrifted(marker.planning!.passthrough, ".planning");
        lines.push(
          `  Compat health (.planning): ${planningDrifted === 0 ? "OK" : `${planningDrifted} file(s) drifted — run /gsd sync`}`,
        );
      }
    } else {
      lines.push(`  Compat health (.planning): not active`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function handleDoctor(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const resolution = /^resolve-evidence\s+(evidence:sha256:[0-9a-f]{64})\s+--action=(discard|preserve|restore)\s+--consent=(\2:sha256:[0-9a-f]{64})$/u.exec(args.trim());
  if (resolution) {
    const { resolveUnboundProjectionEvidence } = await import("./managed-projection-history.js");
    resolveUnboundProjectionEvidence(
      projectRoot(),
      resolution[1]!,
      resolution[2]! as "discard" | "preserve" | "restore",
      resolution[3]!,
    );
    ctx.ui.notify(`Resolved retained projection evidence ${resolution[1]} with ${resolution[2]}.`, "success");
    return;
  }
  const { jsonMode, dryRun, fixFlag, includeBuild, includeTests, mode, requestedScope } = parseDoctorArgs(args);
  const scope = await selectDoctorScope(projectRoot(), requestedScope);
  const effectiveScope = mode === "audit" ? requestedScope : scope;
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen(projectRoot());
  const report = await runGSDDoctor(projectRoot(), {
    fix: mode === "fix" || mode === "heal" || dryRun || fixFlag,
    dryRun,
    scope: effectiveScope,
    includeBuild,
    includeTests,
  });

  if (jsonMode) {
    ctx.ui.notify(formatDoctorReportJson(report), "info");
    return;
  }

  const reportText = formatDoctorReport(report, {
    scope: effectiveScope,
    includeWarnings: mode === "audit",
    maxIssues: mode === "audit" ? 50 : 12,
    title: mode === "audit" ? "GSD doctor audit." : mode === "heal" ? "GSD doctor heal prep." : undefined,
  });

  // Compat health: marker presence + drift vs current projections. Appended to
  // the formatted report so it surfaces in every doctor run without touching
  // the doctor report internals.
  const compatLine = await formatCompatHealthLine(projectRoot());
  const fullReport = compatLine ? `${reportText}\n${compatLine}` : reportText;

  ctx.ui.notify(fullReport, report.ok ? "info" : "warning");

  if (mode === "heal") {
    const unresolved = filterDoctorIssues(report.issues, {
      scope: effectiveScope,
      includeWarnings: true,
    });
    const actionable = unresolved.filter(isDoctorHealActionable);
    if (actionable.length === 0) {
      ctx.ui.notify("Doctor heal found nothing actionable to hand off to the LLM.", "info");
      return;
    }

    const structuredIssues = formatDoctorIssuesForPrompt(actionable);
    dispatchDoctorHeal(pi, effectiveScope, reportText, structuredIssues);
    ctx.ui.notify(`Doctor heal dispatched ${actionable.length} issue(s) to the LLM.`, "info");
  }
}

export async function handleSkillHealth(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const {
    generateSkillHealthReport,
    formatSkillHealthReport,
    formatSkillDetail,
  } = await import("./skill-health.js");

  const basePath = projectRoot();

  // /gsd skill-health <skill-name> — detail view
  if (args && !args.startsWith("--")) {
    const detail = formatSkillDetail(basePath, args);
    ctx.ui.notify(detail, "info");
    return;
  }

  // Parse flags
  const staleMatch = args.match(/--stale\s+(\d+)/);
  const staleDays = staleMatch ? parseInt(staleMatch[1], 10) : undefined;
  const decliningOnly = args.includes("--declining");

  const report = generateSkillHealthReport(basePath, staleDays);

  if (decliningOnly) {
    if (report.decliningSkills.length === 0) {
      ctx.ui.notify("No skills flagged for declining performance.", "info");
      return;
    }
    const filtered = {
      ...report,
      skills: report.skills.filter(s => s.flagged),
    };
    ctx.ui.notify(formatSkillHealthReport(filtered), "info");
    return;
  }

  ctx.ui.notify(formatSkillHealthReport(report), "info");
}

export async function handleCapture(args: string, ctx: ExtensionCommandContext): Promise<void> {
  // Strip surrounding quotes from the argument
  let text = args.trim();
  if (!text) {
    ctx.ui.notify('Usage: /gsd capture "your thought here"', "warning");
    return;
  }
  // Remove wrapping quotes (single or double)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  if (!text) {
    ctx.ui.notify('Usage: /gsd capture "your thought here"', "warning");
    return;
  }

  const basePath = currentDirectoryRoot();

  // Ensure .gsd/ exists — capture should work even without a milestone
  const gsdDir = gsdRoot(basePath);
  if (!existsSync(gsdDir)) {
    mkdirSync(gsdDir, { recursive: true });
  }

  const id = appendCapture(basePath, text);
  ctx.ui.notify(`Captured: ${id} — "${text.length > 60 ? text.slice(0, 57) + "..." : text}"`, "info");
}

export async function handleTriage(ctx: ExtensionCommandContext, pi: ExtensionAPI, basePath: string): Promise<void> {
  if (!hasPendingCaptures(basePath)) {
    ctx.ui.notify("No pending captures to triage.", "info");
    return;
  }

  const pending = loadPendingCaptures(basePath);
  ctx.ui.notify(`Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`, "info");

  // Build context for the triage prompt
  const state = await deriveState(basePath);
  let currentPlan = "";
  let roadmapContext = "";

  if (state.activeMilestone && state.activeSlice) {
    const { resolveSliceFile, resolveMilestoneFile } = await import("./paths.js");
    const planFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "PLAN");
    if (planFile) {
      const { loadFile: load } = await import("./files.js");
      currentPlan = (await load(planFile)) ?? "";
    }
    const roadmapFile = resolveMilestoneFile(basePath, state.activeMilestone.id, "ROADMAP");
    if (roadmapFile) {
      const { loadFile: load } = await import("./files.js");
      roadmapContext = (await load(roadmapFile)) ?? "";
    }
  }

  // Format pending captures for the prompt
  const capturesList = pending.map(c =>
    `- **${c.id}**: "${c.text}" (captured: ${c.timestamp})`
  ).join("\n");

  // Dispatch triage prompt
  const { loadPrompt: loadTriagePrompt } = await import("./prompt-loader.js");
  const prompt = loadTriagePrompt("triage-captures", {
    pendingCaptures: capturesList,
    currentPlan: currentPlan || "(no active slice plan)",
    roadmapContext: roadmapContext || "(no active roadmap)",
  });

  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(gsdHome(), "agent", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");
  const savedTools = scopeGsdWorkflowToolsForDispatch(pi);

  try {
    pi.sendMessage(
      {
        customType: "gsd-triage",
        content: buildWorkflowDispatchContent({ workflow, workflowPath, task: prompt }),
        display: false,
      },
      { triggerTurn: true },
    );
  } finally {
    restoreGsdWorkflowTools(pi, savedTools);
  }
}

export async function handleSteer(change: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const basePath = currentDirectoryRoot();
  const state = await deriveState(basePath);
  const mid = state.activeMilestone?.id ?? "none";
  const sid = state.activeSlice?.id ?? "none";
  const tid = state.activeTask?.id ?? "none";
  const appliedAt = `${mid}/${sid}/${tid}`;

  // Resolve the correct target path: only route to a worktree when auto-mode
  // is actively running there (in-process or remote). A worktree directory may
  // exist from a previous session without being the active runtime path —
  // writing there without a live session would silently drop the override.
  const autoRunning = isAutoActive() || checkRemoteAutoSession(basePath).running;
  const wtPath = autoRunning && mid !== "none"
    ? getAutoWorktreePath(basePath, mid)
    : null;
  const targetPath = wtPath ?? basePath;
  await appendOverride(targetPath, change, appliedAt);

  const overrideLoc = wtPath ? "worktree `.gsd/OVERRIDES.md`" : "`.gsd/OVERRIDES.md`";

  if (isAutoActive()) {
    pi.sendMessage({
      customType: "gsd-hard-steer",
      content: [
        "HARD STEER — User override registered.",
        "",
        `**Override:** ${change}`,
        "",
        `This override has been saved to ${overrideLoc} and will be injected into all future task prompts.`,
        "A document rewrite unit will run before the next task to propagate this change across all active plan documents.",
        "",
        "If you are mid-task, finish your current work respecting this override. The next dispatched unit will be a document rewrite.",
      ].join("\n"),
      display: false,
    }, { triggerTurn: true });
    ctx.ui.notify(`Override registered (${overrideLoc}): "${change}". Will be applied before next task dispatch.`, "info");
  } else {
    pi.sendMessage({
      customType: "gsd-hard-steer",
      content: [
        "HARD STEER — User override registered.",
        "",
        `**Override:** ${change}`,
        "",
        `This override has been saved to ${overrideLoc}.`,
        `Before continuing, read ${overrideLoc} and update the current plan documents to reflect this change.`,
        "Focus on: active slice plan, incomplete task plans, and DECISIONS.md.",
      ].join("\n"),
      display: false,
    }, { triggerTurn: true });
    ctx.ui.notify(`Override registered (${overrideLoc}): "${change}". Update plan documents to reflect this change.`, "info");
  }
}

export async function handleKnowledge(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.split(/\s+/);
  const typeArg = parts[0]?.toLowerCase();

  if (!typeArg || !["rule", "pattern", "lesson"].includes(typeArg)) {
    ctx.ui.notify(
      "Usage: /gsd knowledge <rule|pattern|lesson> <description>\nExample: /gsd knowledge rule Use real DB for integration tests",
      "warning",
    );
    return;
  }

  const entryText = parts.slice(1).join(" ").trim();
  if (!entryText) {
    ctx.ui.notify(`Usage: /gsd knowledge ${typeArg} <description>`, "warning");
    return;
  }

  const type = typeArg as "rule" | "pattern" | "lesson";
  const basePath = currentDirectoryRoot();
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen(basePath);
  const state = await deriveState(basePath);
  const scope = state.activeMilestone?.id
    ? `${state.activeMilestone.id}${state.activeSlice ? `/${state.activeSlice.id}` : ""}`
    : "global";

  // ADR-013 Stage 2c: Patterns and Lessons land in the memories table; the
  // next session-start projection render emits them back into KNOWLEDGE.md.
  // Rules stay file-canonical per ADR-013 line 39 — Rules are not migrated.
  if (type === "rule") {
    await appendKnowledge(basePath, type, entryText, scope);
    ctx.ui.notify(`Added rule to KNOWLEDGE.md: "${entryText}"`, "success");
    return;
  }

  const { captureKnowledgeEntry } = await import("./knowledge-capture.js");
  const { id, written } = captureKnowledgeEntry(basePath, type, entryText, scope);
  if (!written) {
    ctx.ui.notify(`Could not persist ${type} — see logs for details.`, "error");
    return;
  }
  ctx.ui.notify(
    `Captured ${type} ${id} to memories; KNOWLEDGE.md will render it on next session start.`,
    "success",
  );
}

// ─── run-hook unit-ID validation (#2195) ─────────────────────────────────────

/** Body of the canonical milestone ID pattern (`^`/`$` anchors stripped) for composing deeper shapes. */
const MILESTONE_ID = MILESTONE_ID_RE.source.slice(1, -1);

/**
 * ID shape each run-hook scope takes; `example` matches the usage text.
 * Slice IDs are zero-padded to two digits but not capped, so 100+ slices yield
 * `S100`+; task IDs likewise. Both segments accept 2-3 digits.
 */
const RUN_HOOK_ID_SHAPES = {
  milestone: { pattern: MILESTONE_ID_RE, example: "M001" },
  slice: { pattern: new RegExp(`^${MILESTONE_ID}/S\\d{2,3}$`), example: "M001/S01" },
  task: { pattern: new RegExp(`^${MILESTONE_ID}/S\\d{2,3}/T\\d{2,3}$`), example: "M001/S01/T01" },
} as const;

/** Unit types `/gsd run-hook` documents, mapped to the ID shape each one takes. */
const RUN_HOOK_UNIT_SCOPES: Record<string, keyof typeof RUN_HOOK_ID_SHAPES> = {
  "execute-task": "task",
  "plan-slice": "slice",
  "research-milestone": "milestone",
  "complete-slice": "slice",
  "complete-milestone": "milestone",
};

/**
 * Validate a `/gsd run-hook` unit ID against the shape its unit type takes.
 * Returns a user-facing message on failure, or null when the ID is acceptable.
 */
export function validateRunHookUnitId(unitType: string, unitId: string): string | null {
  // Own-property check: a plain-object lookup would resolve "toString"/"constructor" via the prototype.
  if (!Object.hasOwn(RUN_HOOK_UNIT_SCOPES, unitType)) {
    return `Unknown unit type "${unitType}". Expected one of: ${Object.keys(RUN_HOOK_UNIT_SCOPES).join(", ")}`;
  }
  const { pattern, example } = RUN_HOOK_ID_SHAPES[RUN_HOOK_UNIT_SCOPES[unitType]];
  if (!pattern.test(unitId)) {
    return `Invalid unit ID format: "${unitId}" for ${unitType}. Expected format: ${example}`;
  }
  return null;
}

export async function handleRunHook(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) {
    ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
    return;
  }

  const [hookName, unitType, unitId] = parts;
  const basePath = currentDirectoryRoot();

  // Import the hook trigger function
  const { triggerHookManually, formatHookStatus, getHookStatus } = await import("./post-unit-hooks.js");
  const { dispatchHookUnit } = await import("./auto.js");

  // Check if the hook exists
  const hooks = getHookStatus();
  const hookExists = hooks.some(h => h.name === hookName);
  if (!hookExists) {
    ctx.ui.notify(`Hook "${hookName}" not found. Configured hooks:\n${formatHookStatus()}`, "error");
    return;
  }

  // Validate the unit ID against the shape its unit type takes
  const unitIdError = validateRunHookUnitId(unitType, unitId);
  if (unitIdError) {
    ctx.ui.notify(unitIdError, "warning");
    return;
  }

  // Trigger the hook manually
  const hookUnit = triggerHookManually(hookName, unitType, unitId, basePath);
  if (!hookUnit) {
    ctx.ui.notify(`Failed to trigger hook "${hookName}". The hook may be disabled or not configured for unit type "${unitType}".`, "error");
    return;
  }

  ctx.ui.notify(`Manually triggering hook: ${hookName} for ${unitType} ${unitId}`, "info");

  // Dispatch the hook unit directly, bypassing normal pre-dispatch hooks
  const success = await dispatchHookUnit(
    ctx,
    pi,
    hookName,
    unitType,
    unitId,
    hookUnit.prompt,
    hookUnit.model,
    basePath,
  );

  if (!success) {
    ctx.ui.notify("Failed to dispatch hook. Auto-mode may have been cancelled.", "error");
  }
}

// ─── Self-update handler ────────────────────────────────────────────────────

function compareSemverLocal(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

function formatCommandVersion(version: string | null): string {
  return version ? `v${version}` : "unknown";
}

function pickHigherVersionForCommand(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareSemverLocal(a, b) >= 0 ? a : b;
}

// Mirrors resolveGsdBrowserPathVersion in src/update-check.ts — duplicated because
// tsconfig.resources.json rootDir prevents importing from src/.
function resolveGsdBrowserPathVersionForCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GSD_BROWSER_PATH_VERSION?.trim();
  if (explicit) return explicit.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
  try {
    const out = execFileSync("gsd-browser", ["--version"], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// In-session counterpart of `gsd update --models`: refresh the
// models-catalog.json overlay from the published catalog, then reload the
// registry so the new models/pricing are active without a restart (same
// seam as `copilot-models sync --register`).
async function updateModelsCatalogInSession(ctx: ExtensionCommandContext): Promise<void> {
  const { refreshModelsCatalogOverlay } = await import("./models-catalog-refresh.js");
  ctx.ui.notify("Fetching model catalog...", "info");
  const result = await refreshModelsCatalogOverlay();
  if (!result.ok) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  ctx.modelRegistry.refresh();
  const previous = result.previous
    ? ` (was ${result.previous.providers} providers, ${result.previous.models} models)`
    : "";
  ctx.ui.notify(
    `Updated model catalog: ${result.providers} providers, ${result.models} models${previous}. Model registry refreshed.`,
    "info",
  );
}

export async function handleUpdate(ctx: ExtensionCommandContext, args = ""): Promise<void> {
  const { execSync } = await import("node:child_process");

  const target = args.trim();
  if (target === "--models") {
    await updateModelsCatalogInSession(ctx);
    return;
  }
  if (target.includes("--models")) {
    ctx.ui.notify("Usage: /gsd update [browser] [--models] — --models does not take a value", "warning");
    return;
  }
  const browserUpdate = target === "browser" || target === "gsd-browser";
  if (target && !browserUpdate) {
    ctx.ui.notify("Usage: /gsd update [browser] [--models]", "warning");
    return;
  }

  const NPM_PACKAGE = browserUpdate ? GSD_BROWSER_PACKAGE : GSD_PI_PACKAGE;
  const registryUrl = browserUpdate ? BROWSER_UPDATE_REGISTRY_URL : UPDATE_REGISTRY_URL;
  const bundledVersion = browserUpdate
    ? resolveInstalledPackageVersionForCommand(GSD_BROWSER_PACKAGE)
    : null;
  const current = browserUpdate
    ? pickHigherVersionForCommand(bundledVersion, resolveGsdBrowserPathVersionForCommand())
    : process.env.GSD_VERSION || "0.0.0";
  const label = browserUpdate ? "gsd-browser version" : "version";

  ctx.ui.notify(`Current ${label}: ${formatCommandVersion(current)}\nChecking npm registry...`, "info");

  const latest = await fetchLatestVersionForCommand(registryUrl);
  if (!latest) {
    ctx.ui.notify("Failed to reach npm registry. Check your network connection.", "error");
    return;
  }

  if (current && compareSemverLocal(latest, current) <= 0) {
    ctx.ui.notify(`Already up to date (${formatCommandVersion(current)}).`, "info");
    if (!browserUpdate) notifyClaudeRuntimeFloorAdvisory(ctx);
    return;
  }

  ctx.ui.notify(`Updating: ${formatCommandVersion(current)} → v${latest}...`, "info");

  const installCmd = resolveInstallCommand(`${NPM_PACKAGE}@latest`);
  try {
    execSync(installCmd, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let reconcile: ReturnType<typeof reconcileGsdBrowserPathAfterInstall> | null = null;
    if (browserUpdate) {
      try {
        reconcile = reconcileGsdBrowserPathAfterInstall({
          latestVersion: latest,
          compareSemver: compareSemverLocal,
          resolvePathVersion: resolveGsdBrowserPathVersionForCommand,
        });
      } catch {
        // Reconciliation is best-effort: the install above already succeeded,
        // so a reconcile failure must not flip the result to "Update failed".
        reconcile = null;
      }
    }
    const newPathVersion = browserUpdate ? resolveGsdBrowserPathVersionForCommand() : null;
    const pathNote = browserUpdate && !(newPathVersion && compareSemverLocal(newPathVersion, latest) >= 0)
      ? (reconcile?.message
        ?? "Ensure the npm global bin directory is on your PATH so MCP automation uses the updated binary.")
      : "";
    ctx.ui.notify(
      browserUpdate
        ? `Updated gsd-browser to v${latest}. Restart your GSD session to use the new browser automation version.` +
          (reconcile?.action === "synced" && reconcile.message ? `\n${reconcile.message}` : "") +
          (pathNote ? `\nNote: ${pathNote}` : "")
        : `Updated to v${latest}. Restart your GSD session to use the new version.`,
      "info",
    );
    if (!browserUpdate) notifyClaudeRuntimeFloorAdvisory(ctx);
  } catch {
    ctx.ui.notify(
      `Update failed. Try manually: ${installCmd}`,
      "error",
    );
  }
}
