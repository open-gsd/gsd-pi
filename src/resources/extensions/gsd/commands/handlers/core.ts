import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@gsd/pi-coding-agent";
import type { Model } from "@gsd/pi-ai";
import type { GSDState } from "../../types.js";
import { createRequire } from "node:module";

import { computeProgressScore, formatProgressLine } from "../../progress-score.js";
import { isRepositoryDirty } from "../../git-service.js";
import { loadEffectiveGSDPreferences, getGlobalGSDPreferencesPath, getProjectGSDPreferencesPath } from "../../preferences.js";
import { createRepositoryRegistryFromPreferences } from "../../repository-registry.js";
import { ensurePreferencesFile, handlePrefs, handlePrefsMode, handlePrefsWizard, handleLanguage } from "../../commands-prefs-wizard.js";
import { runEnvironmentChecks } from "../../doctor-environment.js";
import { deriveState } from "../../state.js";
import { handleCmux } from "../../commands-cmux.js";
import { setSessionModelOverride } from "../../session-model-override.js";
import { projectRoot } from "../context.js";
import { formattedShortcutPair } from "../../shortcut-defs.js";
import { getVisualBriefOutputDir } from "../../../visual-brief/artifact-policy.js";
import { buildVisualBriefPrompt, parseVisualBriefArgs, VISUAL_BRIEF_USAGE } from "../../../visual-brief/prompts.js";
import { GSD_CORE_IMPLEMENTED_CATALOG } from "../../commands-gsd-core.js";
import { GSD_CORE_ALIAS_CATALOG } from "../gsd-core-aliases.js";
import { readCurrentTaskRecoveryRoute } from "../../task-recovery-domain-operation.js";

export function showHelp(ctx: ExtensionCommandContext, args = ""): void {
  const summaryLines = [
    "GSD — Git Ship Done\n",
    "QUICK START",
    "  /gsd start <tpl>   Start a workflow template",
    "  /gsd               Open the state-aware home menu",
    "  /gsd auto          Run all queued units continuously",
    "  /gsd pause         Pause auto-mode",
    "  /gsd stop          Stop auto-mode gracefully",
    "",
    "VISIBILITY",
    `  /gsd status         Status dashboard  (${formattedShortcutPair("dashboard")})`,
    `  /gsd parallel watch Parallel monitor  (${formattedShortcutPair("parallel")})`,
    `  /gsd notifications  Notification history  (${formattedShortcutPair("notifications")})`,
    "  /gsd visualize      Workflow visualizer",
    "  /gsd report         Generate all HTML reports and open browser",
    "  /gsd brief <mode>   Visual HTML brief (diagram, plan, diff, recap, table, slides)",
    "  /gsd queue          Show queued/dispatched units",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd rethink        Conversational project reorganization",
    "",
    "OBSERVABILITY",
    "  /gsd usage          Current LLM context window usage and session tokens",
    "  /gsd context        Context breakdown chart (skills, injections, history)",
    "  /gsd logs           Browse activity and debug logs",
    "  /gsd debug          Create/list/continue persistent debug sessions",
    "",
    "SETUP",
    "  /gsd onboarding     Re-run setup wizard  [--resume|--reset|--step <name>]",
    "  /gsd setup          Configuration hub  [llm|model|search|remote|keys|prefs|onboarding]",
    "  /gsd init           Project init wizard",
    "  /gsd model          Switch active session model",
    "  /gsd prefs          Manage preferences (alias for /gsd setup prefs)",
    "  /gsd keys           API key manager (LLM + tool keys)",
    "  /gsd doctor         Diagnose and repair .gsd/ state",
    "  /gsd closeout       Recover failed git closeout actions",
    "  /gsd rebuild        Rebuild markdown projections from the DB  [markdown]",
    "",
    "ADDITIONAL COMMANDS",
    "  /gsd map-codebase, /gsd stats, /gsd code-review, /gsd spike, /gsd explore …",
    "  Additional workflows for exploration, review, codebase intel, and more.",
    "  See /gsd help full for the complete list.",
    "",
    "Use /gsd help full for the complete command reference.",
  ];

  const fullLines = [
    "GSD — Git Ship Done\n",
    "WORKFLOW",
    "  /gsd start <tpl>   Start a workflow template (bugfix, spike, feature, hotfix, etc.)",
    "  /gsd templates     List available workflow templates  [info <name>]",
    "  /gsd               Open the state-aware home menu",
    "  /gsd next           Execute next task, then pause  [--dry-run] [--verbose]",
    "  /gsd auto           Run all queued units continuously  [--verbose]",
    "  /gsd stop           Stop auto-mode gracefully",
    "  /gsd pause          Pause auto-mode (preserves state, /gsd auto to resume)",
    "  /gsd discuss        Start guided milestone/slice discussion",
    "  /gsd new-milestone  Create milestone from headless context (used by gsd headless)",
    "  /gsd new-project    Bootstrap a new project (use --deep for staged project-level discovery)",
    "  /gsd quick          Quick task  [--discuss] [--research] [--validate] [--full]",
    "  /gsd dispatch       Dispatch a specific phase directly  [research|plan|execute|complete|validate|reassess|uat|replan]",
    "  /gsd verdict <v>    Override unadopted compatibility validation  [pass|needs-attention|needs-remediation] [--milestone Mxxx] [--rationale \"...\"]",
    "  /gsd parallel       Parallel milestone orchestration  [start|status|stop|pause|resume|merge|watch]",
    "  /gsd workflow       Custom workflow lifecycle  [new|run|list|validate|pause|resume]",
    "",
    "VISIBILITY",
    `  /gsd status         Status dashboard  (${formattedShortcutPair("dashboard")})`,
    `  /gsd parallel watch Open parallel worker monitor  (${formattedShortcutPair("parallel")})`,
    "  /gsd widget         Cycle status widget  [full|small|min|off]",
    "  /gsd visualize      Workflow visualizer (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)",
    "  /gsd brief <mode>   Generate a visual HTML brief  [diagram|plan|diff|recap|table|slides] [topic] [--slides]",
    "  /gsd queue          Show queued/dispatched units and execution order",
    "  /gsd history        View execution history  [--cost] [--phase] [--model] [N]",
    "  /gsd changelog      Show categorized release notes  [version]",
    `  /gsd notifications  View persistent notification history  [clear|tail|filter]  (${formattedShortcutPair("notifications")})`,
    "  /gsd usage          Current LLM context window usage and session tokens  [--json]",
    "  /gsd context        Context breakdown chart  [--open|--text|--json]",
    "  /gsd logs           Browse activity logs, debug logs, and metrics  [debug|tail|clear]",
    "  /gsd debug          Create/list/continue persistent debug sessions",
    "  /gsd copilot-models Inspect and manage the live GitHub Copilot model catalog",
    "  /gsd copilot-models sync          Refresh the accepted Copilot live catalog snapshot",
    "  /gsd copilot-models changes       Show the last accepted Copilot catalog diff",
    "  /gsd copilot-models pricing  Show provider-aware pricing for one model or the accepted snapshot",
    "  /gsd copilot-models promos        Show active, future, and expired Copilot promotions",
    "  /gsd copilot-models doctor        Local-only auth/cache/policy/quarantine diagnostics",
    "  /gsd copilot-models why <model>  Explain a Copilot model's local status/routing/economics (local-only)",
    "  /gsd copilot-models sync --register  Register only complete remote-only Copilot models safely",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd skip <unit>    Prevent a unit from auto-mode dispatch",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd undo-task      Reset a specific task's completion state  [DB + markdown]",
    "  /gsd reset-slice    Reset a slice and all its tasks  [DB + markdown]",
    "  /gsd rate           Rate last unit's model tier  [over|ok|under]",
    "  /gsd rethink        Conversational project reorganization — reorder, park, discard, add milestones",
    "  /gsd park [id]      Park a milestone — skip without deleting  [reason]",
    "  /gsd unpark [id]    Reactivate a parked milestone",
    "  /gsd discard <id>   Permanently discard one milestone (with confirmation)",
    "",
    "PROJECT KNOWLEDGE",
    "  /gsd knowledge <type> <text>   Add a rule to KNOWLEDGE.md or capture a pattern/lesson to memories",
    "  /gsd memory         Query/forget project memories",
    "  /gsd codebase [generate|update|stats]   Manage the CODEBASE.md cache used in prompt context",
    "",
    "SHIPPING & BACKLOG",
    "  /gsd ship           Create a PR from milestone artifacts  [--dry-run|--draft|--base|--force]",
    "  /gsd do <text>      Route freeform text to the right GSD command",
    "  /gsd session-report Show session cost, tokens, and work summary  [--json|--save]",
    "  /gsd backlog        Manage backlog items  [add|promote|remove|list]",
    "  /gsd pr-branch      Create a clean PR branch filtering .gsd/ commits  [--dry-run|--name]",
    "  /gsd add-tests      Generate tests for completed slices",
    "  /gsd eval-review <sliceId>  Audit a slice's AI evaluation strategy  [--force|--show]",
    "  /gsd scan           Rapid codebase assessment  [--focus tech|arch|quality|concerns|tech+arch]",
    "",
    "SETUP & CONFIGURATION",
    "  /gsd onboarding     Re-run setup wizard  [--resume|--reset|--step <name>]",
    "  /gsd setup          Configuration hub  [llm|model|search|remote|keys|prefs|onboarding]",
    "  /gsd init           Project init wizard — detect, configure, bootstrap .gsd/",
    "  /gsd model          Switch active session model  [provider/model|model-id]",
    "  /gsd mode           Set workflow mode (solo/team)  [global|project]",
    "  /gsd prefs          Manage preferences  [global|project|status|wizard|setup|import-claude]  (alias for /gsd setup prefs)",
    "  /gsd cmux           Manage cmux integration  [status|on|off|notifications|sidebar|splits|browser]",
    "  /gsd keys           API key manager (LLM + tool keys)  [list|add|remove|test|rotate|doctor]",
    "  /gsd config         (deprecated) Set tool API keys — use /gsd keys instead",
    "  /gsd show-config    Show effective configuration (models, routing, toggles)",
    "  /gsd hooks          Show post-unit hook configuration",
    "  /gsd run-hook       Manually trigger a specific hook",
    "  /gsd skill-health   Skill lifecycle dashboard",
    "  /gsd extensions     Manage extensions  [list|enable|disable|info]",
    "  /gsd fast           Toggle OpenAI service tier  [on|off|flex|status]",
    "  /gsd mcp            MCP server management  [status|check|discover|test|enable|disable|import|delete|init]",
    "",
    "MAINTENANCE",
    "  /gsd doctor         Diagnose and repair .gsd/ state  [audit|fix|heal] [scope]",
    "  /gsd forensics      Examine execution logs and post-mortem analysis",
    "  /gsd report         Generate all HTML reports and open browser  [--json|--markdown|--html] [--all]",
    "  /gsd export         Alias for /gsd report",
    "  /gsd cleanup        Remove merged branches or snapshots  [branches|snapshots]",
    "  /gsd closeout       Recover failed git closeout actions  [status|retry|resolve] [unit-id]",
    "  /gsd rebuild markdown  Rebuild markdown projections from the canonical DB",
    "  /gsd rebuild database  Reserved for DB-native rebuilds; does not import markdown",
    "  /gsd recover           Preview an evidence-bound DB import after loss/corruption",
    "  /gsd recover <id>      Resume one repaired Task recovery abort (prompts for repair evidence)",
    "  /gsd db restore-backup List or restore a verified pre-migration database backup (destructive)",
    "  /gsd task settle  Settle an orphaned running task Attempt (dry-run first)  <M001/S01/T01> --reason \"...\" [--apply] [--reconcile-lifecycle] [--blocker-accepted]",
    "  /gsd worktree       Manage worktrees from the TUI  [list|merge|clean|remove]",
    "  /gsd migrate        Migrate .planning/ (v1) to DB-backed .gsd/ with backup + audit",
    "  /gsd remote         Control remote auto-mode  [slack|discord|status|disconnect]",
    "  /gsd inspect        Show SQLite DB diagnostics (schema, row counts, recent entries)",
    "  /gsd update         Update GSD to the latest version via npm  [--models refreshes the model catalog]",
    "  /gsd upgrade        Alias for /gsd update",
    "  /gsd language       Set or clear the global response language  [off|clear|<language>]",
    "",
    // The ADDITIONAL COMMANDS block is generated below from the implemented + alias catalogs
    // so it can never drift from TOP_LEVEL_SUBCOMMANDS (which the help-coverage test asserts).
    ...buildAdditionalCommandsHelpLines(),
  ];
  const full = ["full", "--full", "all"].includes(args.trim().toLowerCase());
  ctx.ui.notify((full ? fullLines : summaryLines).join("\n"), "info");
}

/**
 * Build the ADDITIONAL COMMANDS help lines from the implemented-workflow and alias catalogs.
 * Kept in sync with TOP_LEVEL_SUBCOMMANDS automatically — every command appears here.
 */
function buildAdditionalCommandsHelpLines(): string[] {
  const lines: string[] = [
    "ADDITIONAL COMMANDS",
    "  Additional workflows for exploration, review, codebase intel, and project management.",
  ];
  const pad = (cmd: string, width = 20) => cmd.padEnd(width);
  for (const entry of GSD_CORE_IMPLEMENTED_CATALOG) {
    lines.push(`  /gsd ${pad(entry.cmd)} ${entry.desc}`);
  }
  for (const entry of GSD_CORE_ALIAS_CATALOG) {
    lines.push(`  /gsd ${pad(entry.cmd)} ${entry.desc}`);
  }
  return lines;
}

export async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  // Open DB in cold sessions so status uses DB-backed state, not filesystem fallback (#3385)
  const { ensureDbOpen } = await import("../../bootstrap/dynamic-tools.js");
  await ensureDbOpen();
  const state = await deriveState(basePath);

  if (state.registry.length === 0) {
    ctx.ui.notify("No GSD milestones found. Run /gsd to start.", "info");
    return;
  }

  const { GSDDashboardOverlay } = await import("../../dashboard-overlay.js");
  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _kb, done) => new GSDDashboardOverlay(tui, theme, () => done(true)),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 80,
        maxHeight: "92%",
        anchor: "center",
      },
    },
  );

  if (result === undefined) {
    ctx.ui.notify(formatTextStatus(state, basePath), "info");
  }
}

export async function fireStatusViaCommand(ctx: ExtensionContext): Promise<void> {
  await handleStatus(ctx as ExtensionCommandContext);
}

export async function handleVisualize(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Visualizer requires an interactive terminal.", "warning");
    return;
  }

  const { GSDVisualizerOverlay } = await import("../../visualizer-overlay.js");
  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _kb, done) => new GSDVisualizerOverlay(tui, theme, () => done(true)),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 80,
        maxHeight: "90%",
        anchor: "center",
      },
    },
  );

  if (result === undefined) {
    ctx.ui.notify("Visualizer requires an interactive terminal. Use /gsd status for a text-based overview.", "warning");
  }
}

export async function handleBrief(args: string, ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
  const request = parseVisualBriefArgs(args);
  if (!request) {
    ctx.ui.notify(VISUAL_BRIEF_USAGE, "info");
    return;
  }

  if (!pi?.sendUserMessage) {
    ctx.ui.notify("Visual brief generation is unavailable in this context.", "warning");
    return;
  }

  const outputDir = getVisualBriefOutputDir();
  const version = resolveGsdVersion();
  pi.sendUserMessage(buildVisualBriefPrompt(request, { outputDir, version }));
}

const briefRequire = createRequire(import.meta.url);

function resolveGsdVersion(): string | undefined {
  const envVersion = process.env.GSD_VERSION?.trim();
  if (envVersion) return envVersion;
  try {
    const pkg = briefRequire("../../../../../../package.json") as { version?: unknown };
    const fromPkg = typeof pkg.version === "string" ? pkg.version.trim() : "";
    return fromPkg || undefined;
  } catch {
    return undefined;
  }
}

export async function handleSetup(args: string, ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
  const { detectProjectState, hasGlobalSetup } = await import("../../detection.js");
  const { isOnboardingComplete, readOnboardingRecord } = await import("../../onboarding-state.js");

  // Sub-route dispatch — keep redirects but route the canonical work to /gsd
  // onboarding (single source for wizard steps) and /gsd keys (single source
  // for credentials).
  if (args === "onboarding" || args === "wizard") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("", ctx);
    return;
  }
  if (args === "llm" || args === "auth") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step llm", ctx);
    return;
  }
  if (args === "search") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step search", ctx);
    return;
  }
  if (args === "remote") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step remote", ctx);
    return;
  }
  if (args === "model") {
    // Default model picker: persist settings.json default only — do not pin the
    // session override that /gsd model uses, or PREFERENCES.md per-phase models
    // are ignored for the rest of this session (#model-prefs-precedence).
    await handleModel("", ctx, pi, { pinSession: false });
    return;
  }
  if (args === "keys") {
    ctx.ui.notify("Tip: /gsd keys is the canonical command for API key management.", "info");
    const { handleKeys } = await import("../../key-manager.js");
    await handleKeys("", ctx);
    return;
  }
  if (args === "prefs") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }

  // Bare /gsd setup — render the hub: status + actions
  const globalConfigured = hasGlobalSetup();
  const detection = detectProjectState(projectRoot());
  const onboardingDone = isOnboardingComplete();
  const record = readOnboardingRecord();

  const statusLines: string[] = ["GSD Setup\n"];
  statusLines.push(
    onboardingDone
      ? `  Onboarding:         ✓ complete${record.completedAt ? ` (${record.completedAt.slice(0, 10)})` : ""}`
      : `  Onboarding:         ○ not complete  —  /gsd onboarding to start`,
  );
  statusLines.push(`  Global preferences: ${globalConfigured ? "configured" : "not set"}`);
  statusLines.push(`  Project state:      ${detection.state}`);
  if (detection.projectSignals.primaryLanguage) {
    statusLines.push(`  Detected:           ${detection.projectSignals.primaryLanguage}`);
  }

  ctx.ui.notify(statusLines.join("\n"), "info");
  ctx.ui.notify(
    "Configuration hub:\n" +
    "  /gsd setup llm        — LLM provider & auth\n" +
    "  /gsd setup model      — Default model picker\n" +
    "  /gsd setup search     — Web search provider\n" +
    "  /gsd setup remote     — Remote questions (Discord/Slack/Telegram)\n" +
    "  /gsd setup keys       — API keys (alias for /gsd keys)\n" +
    "  /gsd setup prefs      — Global preferences (alias for /gsd prefs)\n" +
    "  /gsd setup onboarding — Full wizard (alias for /gsd onboarding)\n\n" +
    "Tip: /gsd onboarding --resume to continue an incomplete setup.",
    "info",
  );
}

function sortModelsForSelection(models: Model<any>[], currentModel: Model<any> | undefined): Model<any>[] {
  return [...models].sort((a, b) => {
    const aCurrent = currentModel && a.provider === currentModel.provider && a.id === currentModel.id;
    const bCurrent = currentModel && b.provider === currentModel.provider && b.id === currentModel.id;
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.id.localeCompare(b.id);
  });
}

function buildProviderModelGroups(
  models: Model<any>[],
  currentModel: Model<any> | undefined,
): Map<string, Model<any>[]> {
  const byProvider = new Map<string, Model<any>[]>();

  for (const model of sortModelsForSelection(models, currentModel)) {
    let group = byProvider.get(model.provider);
    if (!group) {
      group = [];
      byProvider.set(model.provider, group);
    }
    group.push(model);
  }
  return byProvider;
}

async function selectModelByProvider(
  title: string,
  models: Model<any>[],
  ctx: ExtensionCommandContext,
  currentModel: Model<any> | undefined,
): Promise<Model<any> | undefined> {
  const byProvider = buildProviderModelGroups(models, currentModel);
  const providerOptions = Array.from(byProvider.entries()).map(([provider, group]) =>
    `${provider} (${group.length} model${group.length === 1 ? "" : "s"})`,
  );
  providerOptions.push("(cancel)");

  const providerChoice = await ctx.ui.select(`${title} — choose provider:`, providerOptions);
  if (!providerChoice || typeof providerChoice !== "string" || providerChoice === "(cancel)") return undefined;

  const providerName = providerChoice.replace(/ \(\d+ models?\)$/, "");
  const providerModels = byProvider.get(providerName);
  if (!providerModels || providerModels.length === 0) return undefined;

  const optionToModel = new Map<string, Model<any>>();
  const modelOptions = providerModels.map((model) => {
    const isCurrent = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
    const label = `${isCurrent ? "* " : ""}${model.id}`;
    optionToModel.set(label, model);
    return label;
  });
  modelOptions.push("(cancel)");

  const modelChoice = await ctx.ui.select(`${title} — ${providerName}:`, modelOptions);
  if (!modelChoice || typeof modelChoice !== "string" || modelChoice === "(cancel)") return undefined;
  return optionToModel.get(modelChoice);
}

async function resolveRequestedModel(
  query: string,
  ctx: ExtensionCommandContext,
): Promise<Model<any> | undefined> {
  const { resolveModelId } = await import("../../auto-model-selection.js");
  const models = ctx.modelRegistry.getAvailable();
  const exact = resolveModelId(query, models, ctx.model?.provider);
  if (exact) return exact;

  const lowerQuery = query.toLowerCase();
  const partialMatches = models.filter((model) =>
    model.id.toLowerCase().includes(lowerQuery)
      || `${model.provider}/${model.id}`.toLowerCase().includes(lowerQuery),
  );

  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length === 0 || !ctx.hasUI) return undefined;
  return selectModelByProvider(`Multiple models match "${query}"`, partialMatches, ctx, ctx.model);
}

async function handleModel(
  trimmedArgs: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI | undefined,
  options?: { pinSession?: boolean },
): Promise<void> {
  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length === 0) {
    ctx.ui.notify("No available models found. Check provider auth and model discovery.", "warning");
    return;
  }
  if (!pi) {
    ctx.ui.notify("Model switching is unavailable in this context.", "warning");
    return;
  }

  const trimmed = trimmedArgs.trim();
  let targetModel: Model<any> | undefined;

  if (!trimmed) {
    if (!ctx.hasUI) {
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
      ctx.ui.notify(`Current model: ${current}\nUsage: /gsd model <provider/model|model-id>`, "info");
      return;
    }

    targetModel = await selectModelByProvider("Select session model:", availableModels, ctx, ctx.model);
  } else {
    targetModel = await resolveRequestedModel(trimmed, ctx);
  }

  if (!targetModel) {
    ctx.ui.notify(`Model "${trimmed}" not found. Use /gsd model with an exact provider/model or a unique model ID.`, "warning");
    return;
  }

  const ok = await pi.setModel(targetModel);
  if (!ok) {
    ctx.ui.notify(`No API key for ${targetModel.provider}/${targetModel.id}`, "warning");
    return;
  }

  // /gsd model is an explicit per-session pin for GSD dispatches.
  // This is captured at auto bootstrap so it survives internal session
  // switches during /gsd auto and /gsd next runs. /gsd setup model skips
  // this pin so PREFERENCES.md per-phase models keep precedence.
  const pinSession = options?.pinSession !== false;
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (pinSession && sessionId) {
    setSessionModelOverride(sessionId, {
      provider: targetModel.provider,
      id: targetModel.id,
    });
  }

  const pinNote = pinSession ? "" : " (default updated; per-phase prefs still apply in auto)";
  ctx.ui.notify(`Model: ${targetModel.provider}/${targetModel.id}${pinNote}`, "info");
}

export async function handleCoreCommand(
  trimmed: string,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI,
): Promise<boolean> {
  if (trimmed === "help" || trimmed === "h" || trimmed === "?" || trimmed.startsWith("help ")) {
    showHelp(ctx, trimmed.startsWith("help ") ? trimmed.slice(5).trim() : "");
    return true;
  }
  if (trimmed === "status") {
    await handleStatus(ctx);
    return true;
  }
  if (trimmed === "visualize") {
    await handleVisualize(ctx);
    return true;
  }
  if (trimmed === "brief" || trimmed.startsWith("brief ")) {
    await handleBrief(trimmed.replace(/^brief\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "widget" || trimmed.startsWith("widget ")) {
    const { cycleWidgetMode, setWidgetMode, getWidgetMode } = await import("../../auto-dashboard.js");
    const arg = trimmed.replace(/^widget\s*/, "").trim();
    if (arg === "full" || arg === "small" || arg === "min" || arg === "off") {
      setWidgetMode(arg);
    } else {
      cycleWidgetMode();
    }
    ctx.ui.notify(`Widget: ${getWidgetMode()}`, "info");
    return true;
  }
  if (trimmed === "model" || trimmed.startsWith("model ")) {
    await handleModel(trimmed.replace(/^model\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "mode" || trimmed.startsWith("mode ")) {
    const modeArgs = trimmed.replace(/^mode\s*/, "").trim();
    const scope = modeArgs === "project" ? "project" : "global";
    const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
    await ensurePreferencesFile(path, ctx, scope);
    await handlePrefsMode(ctx, scope);
    return true;
  }
  if (trimmed === "prefs" || trimmed.startsWith("prefs ")) {
    await handlePrefs(trimmed.replace(/^prefs\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "language" || trimmed.startsWith("language ")) {
    await handleLanguage(trimmed.replace(/^language\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "cmux" || trimmed.startsWith("cmux ")) {
    await handleCmux(trimmed.replace(/^cmux\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "usage" || trimmed.startsWith("usage ")) {
    const { handleUsage } = await import("../../commands-usage.js");
    await handleUsage(trimmed.replace(/^usage\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "context" || trimmed.startsWith("context ")) {
    const { handleContext } = await import("../../commands-context.js");
    await handleContext(trimmed.replace(/^context\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "show-config") {
    const { GSDConfigOverlay, formatConfigText, buildCollectConfigOptions } = await import("../../config-overlay.js");
    const configOptions = buildCollectConfigOptions(ctx, projectRoot());
    const result = await ctx.ui.custom<boolean>(
      (tui, theme, _kb, done) => new GSDConfigOverlay(tui, theme, () => done(true), configOptions),
      {
        overlay: true,
        overlayOptions: {
          width: "65%",
          minWidth: 55,
          maxHeight: "85%",
          anchor: "center",
        },
      },
    );
    if (result === undefined) {
      ctx.ui.notify(formatConfigText(configOptions), "info");
    }
    return true;
  }
  if (trimmed === "setup" || trimmed.startsWith("setup ")) {
    await handleSetup(trimmed.replace(/^setup\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "onboarding" || trimmed.startsWith("onboarding ")) {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding(trimmed.replace(/^onboarding\s*/, "").trim(), ctx);
    return true;
  }
  return false;
}

export function formatTextStatus(state: GSDState, basePath?: string): string {
  const root = basePath ?? projectRoot();
  const lines: string[] = ["GSD Status\n"];
  lines.push(formatProgressLine(computeProgressScore()));
  lines.push("");
  lines.push(`Phase: ${state.phase}`);

  if (state.activeMilestone) {
    lines.push(`Active milestone: ${state.activeMilestone.id} — ${state.activeMilestone.title}`);
  }
  if (state.activeSlice) {
    lines.push(`Active slice: ${state.activeSlice.id} — ${state.activeSlice.title}`);
  }
  if (state.activeTask) {
    lines.push(`Active task: ${state.activeTask.id} — ${state.activeTask.title}`);
  }
  if (state.progress) {
    const { milestones, slices, tasks } = state.progress;
    const parts: string[] = [`milestones ${milestones.done}/${milestones.total}`];
    if (slices) parts.push(`slices ${slices.done}/${slices.total}`);
    if (tasks) parts.push(`tasks ${tasks.done}/${tasks.total}`);
    lines.push(`Progress: ${parts.join(", ")}`);
  }
  if (state.nextAction) {
    lines.push(`Next: ${state.nextAction}`);
  }
  if (state.blockers.length > 0) {
    lines.push(`Blockers: ${state.blockers.join("; ")}`);
  }
  if (state.activeMilestone && state.activeSlice && state.activeTask) {
    try {
      const recovery = readCurrentTaskRecoveryRoute({
        milestoneId: state.activeMilestone.id,
        sliceId: state.activeSlice.id,
        taskId: state.activeTask.id,
      });
      if (recovery?.action === "abort") {
        const eligibility = recovery.resumeEligibility;
        const recoveryStatus = recovery.resumeAuthorized
          ? "successor Attempt authorized"
          : eligibility?.eligible
            ? "resume eligible"
            : `resume unavailable (${eligibility?.failedGuard ?? "unknown"}: ${eligibility?.detail ?? "not eligible"})`;
        lines.push(
          `Task recovery: abort ${recovery.recoveryActionId} — ${recoveryStatus}`,
        );
      }
    } catch {
      // Status remains available for legacy/incomplete databases that do not
      // yet have the canonical Task recovery tables.
    }
  }
  if (state.registry.length > 0) {
    lines.push("");
    lines.push("Milestones:");
    for (const milestone of state.registry) {
      const icon = milestone.status === "complete"
        ? "✓"
        : milestone.status === "active"
          ? "▶"
          : milestone.status === "parked"
            ? "⏸"
            : "○";
      lines.push(`  ${icon} ${milestone.id}: ${milestone.title} (${milestone.status})`);
    }
  }

  const envResults = runEnvironmentChecks(root);
  const envIssues = envResults.filter((result) => result.status !== "ok");
  if (envIssues.length > 0) {
    lines.push("");
    lines.push("Environment:");
    for (const issue of envIssues) {
      lines.push(`  ${issue.status === "error" ? "✗" : "⚠"} ${issue.message}`);
    }
  }

  // Parent-workspace per-repository git health (#818). No-op for single-repo
  // projects; surfaces which declared child repos have uncommitted changes.
  const repoBlock = buildWorkspaceRepoStatusBlock(root);
  if (repoBlock) {
    lines.push("");
    lines.push("Repositories:");
    lines.push(repoBlock);
  }

  return lines.join("\n");
}

/**
 * Build a per-repository dirty/clean summary for parent-workspace status.
 * Returns "" for single-repo (project-mode) projects so the status output is
 * unchanged; otherwise one line per declared child repository.
 */
function buildWorkspaceRepoStatusBlock(basePath: string): string {
  let registry;
  try {
    registry = createRepositoryRegistryFromPreferences(basePath, loadEffectiveGSDPreferences(basePath)?.preferences);
  } catch {
    return "";
  }
  if (registry.mode !== "parent") return "";
  const childRepos = registry.repositories.filter((repo) => repo.id !== "project");
  if (childRepos.length === 0) return "";

  return childRepos
    .map((repo) => {
      const dirty = isRepositoryDirty(repo.root);
      return `  ${dirty ? "✗" : "✓"} ${repo.id}${repo.role ? ` — ${repo.role}` : ""}${dirty ? " (uncommitted changes)" : " (clean)"}`;
    })
    .join("\n");
}
