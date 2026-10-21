// gsd-pi + src/resources/extensions/gsd/bootstrap/agent-end-recovery.ts - Handles provider and agent-end recovery for GSD auto-mode.

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentEndEvent, ErrorContext } from "../auto/types.js";
import { logWarning } from "../workflow-logger.js";
import {
  checkDeepProjectSetupAfterTurn,
  checkAutoStartAfterDiscuss,
  maybeHandleReadyPhraseWithoutFiles,
  maybeHandleEmptyIntentTurn,
  resetEmptyTurnCounter,
} from "../guided-flow.js";
import { clearPathCache, gsdRoot } from "../paths.js";
import {
  getAutoDashboardData,
  getAutoModeStartModel,
  isAutoActive,
  isAutoCompletionStopInProgress,
  pauseAuto,
  setCurrentDispatchedModelId,
  setCurrentUnitModelForRecovery,
} from "../auto.js";
import { getNextFallbackModel, resolveModelWithFallbacksForUnit } from "../preferences.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import {
  isSessionSwitchAbortGraceActive,
  isSessionSwitchInFlight,
  resolveAgentEnd,
  resolveAgentEndCancelled,
} from "../auto/resolve.js";
import { shouldIgnoreAgentEndForActiveUnit } from "../auto/unit-runner-events.js";
import { isTaskExecutionReadyForHostVerification } from "../auto/task-execution-cutover.js";
import { resolveModelId } from "../auto-model-selection.js";
import { resolveProjectRoot } from "../worktree.js";
import { clearDiscussionFlowState } from "./write-gate.js";
import { scheduleFallbackContinuation } from "./fallback-continuation.js";
import { clearGuidedUnitContext, getGuidedUnitContext, type GuidedUnitContext } from "../guided-unit-context.js";
import { resumeAutoAfterProviderDelay } from "./provider-error-resume.js";
import {
  classifyError,
  createRetryState,
  resetRetryState,
  isTransient,
  type ErrorClass,
} from "../error-classifier.js";
import { blockModel, blockModelUntil, isModelBlocked, isModelTemporarilyUnavailable } from "../blocked-models.js";
import { getProjectGSDPreferencesPath } from "../preferences.js";
import { resolveProviderErrorGuidance } from "../provider-error-guidance.js";
import { formatGuidance } from "../guidance.js";

const retryState = createRetryState();
const MAX_NETWORK_RETRIES = 2;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function _hasEmptyAgentEndContent(content: unknown): boolean {
  if (content == null) return true;
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every((block) => {
    if (!block || typeof block !== "object") return true;
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type !== "text") return false;
    return typeof typedBlock.text !== "string" || typedBlock.text.trim() === "";
  });
}

/**
 * Cap on auto-resume attempts for sustained transient-provider errors.
 *
 * Exported so tests assert against the shared constant instead of
 * regex-scraping the source literal (see #4837). Raising this value to
 * handle longer provider overloads should update the single constant; the
 * test in provider-errors.test.ts consumes it directly.
 */
export const MAX_TRANSIENT_AUTO_RESUMES = 8;

/**
 * Reset the module-level retry state so a resumed auto-session starts fresh.
 * Called by provider-error-resume.ts before startAuto() — without this, the
 * consecutiveTransientCount accumulates across pause/resume cycles and locks
 * out auto-resume after MAX_TRANSIENT_AUTO_RESUMES total (not consecutive) errors.
 */
export function resetTransientRetryState(): void {
  resetRetryState(retryState);
}

function resolveAgentEndBasePath(): string | undefined {
  try {
    return resolveProjectRoot(process.cwd());
  } catch {
    return undefined;
  }
}

export function _buildAbortedPauseContext(lastMsg: { errorMessage?: unknown }): {
  message: string;
  category: "aborted";
  isTransient: true;
} {
  const hasErrorMessage = Object.prototype.hasOwnProperty.call(lastMsg, "errorMessage") && !!lastMsg.errorMessage;
  return {
    message: hasErrorMessage ? String(lastMsg.errorMessage) : "Operation aborted",
    category: "aborted",
    isTransient: true,
  };
}

export function isUserInitiatedAbortMessage(message: string | undefined | null): boolean {
  if (!message) return false;
  return /\b(?:claude code process aborted by user|request aborted by user|process aborted by user)\b/i.test(message);
}

export function shouldDeferTransientErrorToCoreRetry(
  cls: ErrorClass,
  rawErrorMsg: string,
  deferCheckMsg: string = rawErrorMsg,
): boolean {
  if (!isTransient(cls) || cls.kind === "rate-limit") return false;
  // Empty rawErrorMsg means the SDK terminated the session without providing an
  // error string — core is done, not mid-retry.  GSD must schedule its own
  // retry rather than silently deferring to a core that has already exited.
  if (!rawErrorMsg) return false;
  return !/retry failed after \d+ attempts:/i.test(deferCheckMsg);
}

type ProviderModelFallbackParams = {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  rejectedProvider?: string;
  rejectedId?: string;
  basePath?: string;
  unitType?: string;
  switchedNotify: (label: string) => void;
};

/** Try configured fallbacks, then the auto-mode start model. Returns true if switched. */
async function tryProviderModelFallback(params: ProviderModelFallbackParams): Promise<boolean> {
  const { ctx, pi, rejectedProvider, rejectedId, basePath, unitType, switchedNotify } = params;
  if (!basePath || !unitType) return false;

  const modelConfig = resolveModelWithFallbacksForUnit(unitType);
  const availableModels = ctx.modelRegistry.getAvailable();

  if (modelConfig && modelConfig.fallbacks.length > 0) {
    let cursorModelId: string | undefined = rejectedId;
    while (true) {
      const nextModelId = getNextFallbackModel(cursorModelId, modelConfig);
      if (!nextModelId) break;
      const candidate = resolveModelId(nextModelId, availableModels, rejectedProvider);
      if (
        candidate &&
        !isModelBlocked(basePath, candidate.provider, candidate.id) &&
        !isModelTemporarilyUnavailable(basePath, candidate.provider, candidate.id)
      ) {
        const ok = await pi.setModel(candidate, { persist: false });
        if (ok) {
          setCurrentUnitModelForRecovery(candidate);
          setCurrentDispatchedModelId({ provider: candidate.provider, id: candidate.id });
          switchedNotify(`${candidate.provider}/${candidate.id}`);
          scheduleFallbackContinuation(pi);
          return true;
        }
      }
      cursorModelId = nextModelId;
    }
  }

  const sessionModel = getAutoModeStartModel();
  if (
    sessionModel &&
    !(sessionModel.provider === rejectedProvider && sessionModel.id === rejectedId) &&
    !isModelBlocked(basePath, sessionModel.provider, sessionModel.id) &&
    !isModelTemporarilyUnavailable(basePath, sessionModel.provider, sessionModel.id)
  ) {
    const startModel = availableModels.find(
      (m) => m.provider === sessionModel.provider && m.id === sessionModel.id,
    );
    if (startModel) {
      const ok = await pi.setModel(startModel, { persist: false });
      if (ok) {
        setCurrentUnitModelForRecovery(startModel);
        setCurrentDispatchedModelId({ provider: startModel.provider, id: startModel.id });
        switchedNotify(`${startModel.provider}/${startModel.id}`);
        scheduleFallbackContinuation(pi);
        return true;
      }
    }
  }

  return false;
}

async function pauseForProviderModelRejection(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  options: {
    errorDetail: string;
    rawErrorMsg: string;
    rejectedProvider?: string;
    rejectedId?: string;
    unitType?: string;
    basePath?: string;
    blockReason: string;
    blockNotify: string;
    shouldBlockModel?: boolean;
    switchedNotify: (label: string) => void;
    buildPauseDetail: () => string;
  },
): Promise<void> {
  const {
    errorDetail,
    rawErrorMsg,
    rejectedProvider,
    rejectedId,
    unitType,
    basePath,
    blockReason,
    blockNotify,
    shouldBlockModel = true,
    switchedNotify,
    buildPauseDetail,
  } = options;

  if (shouldBlockModel && basePath && rejectedProvider && rejectedId) {
    try {
      blockModel(basePath, rejectedProvider, rejectedId, rawErrorMsg || blockReason);
      ctx.ui.notify(blockNotify, "warning");
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logWarning("bootstrap", `Failed to persist blocked model: ${m}`);
    }
  }

  const switched = await tryProviderModelFallback({
    ctx,
    pi,
    rejectedProvider,
    rejectedId,
    basePath,
    unitType,
    switchedNotify,
  });
  if (switched) return;

  const pauseDetail = buildPauseDetail();
  await pauseAutoForProviderError(ctx.ui, errorDetail, () =>
    pauseAuto(ctx, pi, {
      message: pauseDetail,
      category: "provider",
      isTransient: false,
    }),
  {
    isRateLimit: false,
    isTransient: false,
    retryAfterMs: 0,
  });
}

function isBareClaudeCodeSessionSwitchAbortMarker(message: string | undefined | null): boolean {
  if (!message) return false;
  const normalized = message.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized === "claude code process aborted by user"
    || normalized === "request aborted by user"
    || normalized === "process aborted by user"
    || normalized === "claude code stream aborted by caller";
}

function readAssistantTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function isClaudeCodeSessionSwitchAbortMessage(lastMsg: unknown): boolean {
  if (!lastMsg || typeof lastMsg !== "object") return false;
  const m = lastMsg as { stopReason?: unknown; errorMessage?: unknown; content?: unknown };
  const carriers = [
    m.errorMessage ? String(m.errorMessage) : "",
    readAssistantTextContent(m.content),
  ].filter((value) => value.trim().length > 0);

  if ((m.stopReason === "error" || m.stopReason === "aborted") && carriers.length > 0) {
    return carriers.every(isBareClaudeCodeSessionSwitchAbortMarker);
  }

  return false;
}

export function isBareClaudeCodeStreamAbortPlaceholder(lastMsg: unknown): boolean {
  if (!lastMsg || typeof lastMsg !== "object") return false;
  const m = lastMsg as { stopReason?: unknown; errorMessage?: unknown; content?: unknown };
  if (m.stopReason !== "aborted" || m.errorMessage) return false;
  const text = readAssistantTextContent(m.content).trim().replace(/\s+/g, " ").toLowerCase();
  return text === "claude code stream aborted by caller";
}

/**
 * Resolve an agent_end event observed while a session switch is in flight.
 *
 * #5538-followup: When `newSession()` aborts an in-flight stream as part of a
 * session transition (run-unit.ts:63 → _settleCurrentTurnForSessionTransition
 * → agent.abort()), the SDK emits "Claude Code process aborted by user" or
 * "Request aborted by user" against the previous unit's turn. The previous
 * code path treated that as a user cancellation and propagated it to the next
 * unit via the pending-switch-cancellation queue, killing auto-mode with
 * "Auto-mode stopped — Unit aborted: Claude Code process aborted by user"
 * even though no user input occurred.
 *
 * Abort markers are intentionally ignored when the abort fires while the
 * session-switch is in flight: the abort belongs to the old turn being torn
 * down by newSession(), not to the next unit.
 */
export function _handleSessionSwitchAgentEnd(
  lastMsg: unknown,
  resolveCancelled: (ctx: ErrorContext) => boolean,
): void {
  if (!lastMsg || typeof lastMsg !== "object") return;
  const m = lastMsg as { stopReason?: unknown; errorMessage?: unknown; content?: unknown };

  if (isClaudeCodeSessionSwitchAbortMessage(m)) {
    // Internal abort from in-flight session transition — drop on the floor.
    return;
  }

  if (m.stopReason === "error") {
    const rawErrorMsg = m.errorMessage ? String(m.errorMessage) : "";
    if (isBareClaudeCodeSessionSwitchAbortMarker(rawErrorMsg)) {
      // Internal abort from in-flight session transition — drop on the floor.
      return;
    }
    return;
  }

  if (m.stopReason === "aborted") {
    return;
  }
}

export function resolveAgentEndErrorDisplay(
  rawErrorMsg: string,
  content: unknown,
): string {
  const isUseless = !rawErrorMsg || /^(success|ok|true|error|unknown)$/i.test(rawErrorMsg.trim());
  if (isUseless && Array.isArray(content)) {
    const textBlock = content.find((b: any) => b.type === "text" && b.text);
    if (textBlock) return (textBlock as any).text.slice(0, 300);
  }
  return rawErrorMsg;
}

export function isTerminalDeletedWorktreeProviderError(
  message: string | undefined | null,
): boolean {
  if (!message) return false;
  if (!/\bdoes not exist\b/i.test(message)) return false;
  return /[/\\]\.gsd[/\\](?:projects[/\\][^/\\]+[/\\])?worktrees[/\\][^/\\\s"']+/i.test(message);
}

type MessageEndLike = {
  message: unknown;
};

export function suppressTerminalDeletedWorktreeMessageEnd(event: MessageEndLike): boolean {
  const message = event.message as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
  };
  if (!isAutoCompletionStopInProgress()) return false;
  if (message?.role !== "assistant" || message.stopReason !== "error") return false;

  const rawErrorMsg = message.errorMessage ? String(message.errorMessage) : "";
  const displayMsg = resolveAgentEndErrorDisplay(rawErrorMsg, message.content);
  if (!isTerminalDeletedWorktreeProviderError(`${rawErrorMsg}\n${displayMsg}`)) return false;

  message.stopReason = "completed";
  message.errorMessage = undefined;
  message.content = [];
  logWarning(
    "bootstrap",
    `Suppressing stale deleted-worktree provider error during terminal completion reroot: ${displayMsg || rawErrorMsg}`,
  );
  return true;
}

function modelLabel(ctx: ExtensionContext): string {
  const provider = ctx.model?.provider;
  const id = ctx.model?.id;
  return provider && id ? `${provider}/${id}` : "unknown model";
}

function isFatalManualGuidedTerminalFailure(lastMsg: unknown): boolean {
  if (!isObjectRecord(lastMsg) || !("stopReason" in lastMsg)) return false;
  if (lastMsg.stopReason === "error") {
    const rawErrorMsg = ("errorMessage" in lastMsg && lastMsg.errorMessage) ? String(lastMsg.errorMessage) : "";
    if (isUserInitiatedAbortMessage(rawErrorMsg)) return false;
    return true;
  }
  if (lastMsg.stopReason !== "aborted") return false;

  const content = "content" in lastMsg ? lastMsg.content : undefined;
  const hasErrorMessage = "errorMessage" in lastMsg && !!lastMsg.errorMessage;
  return hasErrorMessage || !_hasEmptyAgentEndContent(content);
}

function terminalFailureDetail(lastMsg: unknown): string {
  if (!isObjectRecord(lastMsg)) return "Provider turn ended with an unknown terminal error.";
  const rawErrorMsg = ("errorMessage" in lastMsg && lastMsg.errorMessage) ? String(lastMsg.errorMessage) : "";
  const content = "content" in lastMsg ? lastMsg.content : undefined;
  const displayMsg = resolveAgentEndErrorDisplay(rawErrorMsg, content).replace(/\s+/g, " ").trim();
  if (displayMsg) return displayMsg.length > 300 ? `${displayMsg.slice(0, 300)}...` : displayMsg;
  return lastMsg.stopReason === "aborted"
    ? "Provider turn aborted with error context."
    : "Provider stream ended with stopReason=error.";
}

function nextManualActivitySequence(activityDir: string): string {
  let maxSeq = 0;
  try {
    for (const file of readdirSync(activityDir)) {
      const match = /^(\d+)-/.exec(file);
      if (match) maxSeq = Math.max(maxSeq, Number.parseInt(match[1]!, 10));
    }
  } catch {
    return "001";
  }
  return String(maxSeq + 1).padStart(3, "0");
}

function writeManualGuidedTerminalErrorActivity(
  basePath: string,
  unitType: string,
  model: string,
  detail: string,
  stopReason: unknown,
): void {
  const activityDir = join(gsdRoot(basePath), "activity");
  mkdirSync(activityDir, { recursive: true });
  const seq = nextManualActivitySequence(activityDir);
  const safeUnitType = unitType.replace(/[^a-z0-9_.-]+/gi, "-");
  const markerPath = join(activityDir, `${seq}-${safeUnitType}-manual-terminal-provider-error.jsonl`);
  const message = `Manual guided ${unitType} turn ended with provider ${String(stopReason)} on ${model}: ${detail}`;
  writeFileSync(
    markerPath,
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "manual-guided-terminal-provider-error",
        toolName: "provider",
        isError: true,
        content: [{ type: "text", text: message }],
      },
    }) + "\n",
    "utf-8",
  );
}

function observeManualDiscussTerminalError(
  ctx: ExtensionContext,
  lastMsg: unknown,
  guidedUnit: GuidedUnitContext | null,
): void {
  if (!guidedUnit?.unitType.startsWith("discuss-")) return;
  if (!isFatalManualGuidedTerminalFailure(lastMsg)) return;

  const model = modelLabel(ctx);
  const detail = terminalFailureDetail(lastMsg);
  ctx.ui.notify(
    `Manual /gsd discuss ${guidedUnit.unitType} ended with a provider error on ${model}: ${detail}`,
    "warning",
  );

  try {
    writeManualGuidedTerminalErrorActivity(
      guidedUnit.basePath,
      guidedUnit.unitType,
      model,
      detail,
      isObjectRecord(lastMsg) ? lastMsg.stopReason : "unknown",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning("bootstrap", `Failed to write manual guided terminal-error activity marker: ${message}`);
  }
}

async function pauseTransientWithBackoff(
  cls: ErrorClass,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  errorDetail: string,
  isRateLimit: boolean,
): Promise<void> {
  retryState.consecutiveTransientCount += 1;
  const baseRetryAfterMs = "retryAfterMs" in cls ? cls.retryAfterMs : 15_000;
  const retryAfterMs = baseRetryAfterMs * 2 ** Math.max(0, retryState.consecutiveTransientCount - 1);
  const allowAutoResume = retryState.consecutiveTransientCount <= MAX_TRANSIENT_AUTO_RESUMES;
  if (!allowAutoResume) {
    ctx.ui.notify(`Transient provider errors persisted after ${MAX_TRANSIENT_AUTO_RESUMES} auto-resume attempts. Pausing for manual review.`, "warning");
  }
  await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
    message: `Provider error${errorDetail}`,
    category: "provider",
    isTransient: allowAutoResume,
    retryAfterMs,
  }), {
    isRateLimit,
    isTransient: allowAutoResume,
    retryAfterMs,
    resume: allowAutoResume
      ? () => {
        void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Provider error recovery delay elapsed, but auto-mode failed to resume: ${message}`, "error");
        });
      }
      : undefined,
  });
}

export async function handleAgentEnd(
  pi: ExtensionAPI,
  event: AgentEndEvent,
  ctx: ExtensionContext,
): Promise<void> {
  // #4648 — Invalidate the directory-listing cache before any artifact-existence
  // checks. The LLM may have written milestone files (CONTEXT.md, ROADMAP.md,
  // PROJECT.md, REQUIREMENTS.md) via tool calls during the turn that just
  // ended. `paths.ts` caches readdir() results without a TTL, so without this
  // flush, `resolveMilestoneFile` returns the pre-write listing and the guards
  // below (`checkAutoStartAfterDiscuss` and `maybeHandleReadyPhraseWithoutFiles`)
  // falsely report files as missing — producing a spurious "ready signal
  // rejected" loop even though the files are on disk.
  clearPathCache();
  const basePath = resolveAgentEndBasePath();
  const lastMsg = event.messages[event.messages.length - 1];
  const guidedUnit = basePath ? getGuidedUnitContext(basePath) ?? getGuidedUnitContext() : getGuidedUnitContext();
  clearGuidedUnitContext(guidedUnit?.basePath ?? basePath);

  try {
    if (await checkDeepProjectSetupAfterTurn(event, ctx, basePath)) {
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning("bootstrap", `checkDeepProjectSetupAfterTurn failed: ${message}`);
  }

  if (checkAutoStartAfterDiscuss(basePath)) {
    clearDiscussionFlowState(basePath ?? process.cwd());
    return;
  }

  // #4573 — When the LLM emits "Milestone X ready." but the required files
  // are missing, `checkAutoStartAfterDiscuss` returns false silently. Surface
  // that and nudge the LLM to complete the writes before the user hits the
  // downstream "All milestones complete" warning loop.
  if (maybeHandleReadyPhraseWithoutFiles(event, basePath)) return;

  // #4573 — Empty-turn recovery: if the LLM announced intent in prose but
  // emitted no tool calls, nudge it to execute. Fires only when auto-mode is
  // active or a discussion autostart is pending (non-auto interactive discuss
  // is user-driven). Runs before `isAutoActive` early return so pending
  // discussions (where isAutoActive may be false) still get recovered.
  if (maybeHandleEmptyIntentTurn(event, isAutoActive(), basePath)) return;

  if (!isAutoActive()) {
    observeManualDiscussTerminalError(ctx, lastMsg, guidedUnit);
    return;
  }

  if (shouldIgnoreAgentEndForActiveUnit(event)) {
    return;
  }

  if (isSessionSwitchInFlight()) {
    _handleSessionSwitchAgentEnd(lastMsg, resolveAgentEndCancelled);
    return;
  }

  if (isSessionSwitchAbortGraceActive() && isClaudeCodeSessionSwitchAbortMessage(lastMsg)) {
    // Claude Code can report the abort from `newSession()` a few hundred ms
    // after the guard drops. That event belongs to the old turn; do not let it
    // cancel the freshly-dispatched unit.
    return;
  }

  // #2218 — A run killed by timeout carries the origin through the agent_end
  // seam (pi-agent-core → session bridge). It must surface as a timeout
  // cancellation — retryable, user-visible, ledger-recorded — instead of
  // falling through to the success resolve as a clean completion. The #2695
  // empty-content abort semantics below are untouched: they only apply to ends
  // without a timeout origin.
  if (event.abortOrigin === "timeout") {
    resolveAgentEndCancelled({
      message: "Unit ended by timeout before completing",
      category: "timeout",
      isTransient: true,
    });
    return;
  }

  if (isBareClaudeCodeStreamAbortPlaceholder(lastMsg)) {
    if (isSessionSwitchAbortGraceActive()) {
      // Old turn leaking through after a session switch — drop it.
      return;
    }

    // Mid-unit stream abort with no diagnostic. Treat as non-fatal so the loop
    // can continue, but surface it to the user and resolve the in-flight unit.
    ctx.ui.notify("Claude Code stream aborted mid-unit (no diagnostic). Continuing.", "warning");
    try {
      resetRetryState(retryState);
      resolveAgentEnd(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Auto-mode error after stream-abort placeholder: ${message}. Stopping auto-mode.`, "error");
      try { await pauseAuto(ctx, pi); } catch (e) { logWarning("bootstrap", `pauseAuto failed after stream-abort placeholder: ${(e as Error).message}`); }
    }
    return;
  }

  if (isObjectRecord(lastMsg) && "stopReason" in lastMsg && lastMsg.stopReason === "aborted") {
    if (isAutoCompletionStopInProgress()) {
      resetRetryState(retryState);
      resolveAgentEnd(event);
      return;
    }

    // Empty content with aborted stopReason is a non-fatal agent stop (the LLM
    // chose to end without producing output). Only pause on genuine fatal aborts
    // that carry error context — e.g. errorMessage field or non-empty content
    // indicating a mid-stream failure. (#2695)
    const content = "content" in lastMsg ? lastMsg.content : undefined;
    const hasEmptyContent = _hasEmptyAgentEndContent(content);
    const hasErrorMessage = "errorMessage" in lastMsg && !!lastMsg.errorMessage;

    if (hasEmptyContent && !hasErrorMessage) {
      // Non-fatal: treat as a normal agent end so the loop can continue
      // instead of entering a stuck re-dispatch cycle.
      try {
        resetRetryState(retryState);
        resolveAgentEnd(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Auto-mode error after empty-content abort: ${message}. Stopping auto-mode.`, "error");
        try { await pauseAuto(ctx, pi); } catch (e) { logWarning("bootstrap", `pauseAuto failed after empty-content abort: ${(e as Error).message}`); }
      }
      return;
    }

    await pauseAuto(ctx, pi, _buildAbortedPauseContext(lastMsg as { errorMessage?: unknown }));
    return;
  }
  if (isObjectRecord(lastMsg) && "stopReason" in lastMsg && lastMsg.stopReason === "error") {
    // #3588: errorMessage can be useless (e.g. "success") while the real error
    // is in the assistant message text content. Fall back to content when
    // errorMessage looks uninformative.
    const rawErrorMsg = ("errorMessage" in lastMsg && lastMsg.errorMessage) ? String(lastMsg.errorMessage) : "";
    if (isUserInitiatedAbortMessage(rawErrorMsg)) {
      if (isAutoCompletionStopInProgress()) {
        resetRetryState(retryState);
        resolveAgentEnd(event);
        return;
      }
      resolveAgentEndCancelled({
        message: rawErrorMsg,
        category: "aborted",
        isTransient: false,
      });
      return;
    }
    // #3588/#956: When errorMessage is uninformative, extract the real error
    // from assistant text. Prefer rawErrorMsg for classification to avoid
    // prose false-positives, but use display text when rawErrorMsg is empty.
    const displayMsg = resolveAgentEndErrorDisplay(
      rawErrorMsg,
      "content" in lastMsg ? lastMsg.content : undefined,
    );
    if (
      isAutoCompletionStopInProgress() &&
      isTerminalDeletedWorktreeProviderError(`${rawErrorMsg}\n${displayMsg}`)
    ) {
      resetRetryState(retryState);
      logWarning(
        "bootstrap",
        `Ignoring stale deleted-worktree provider error during terminal completion reroot: ${displayMsg || rawErrorMsg}`,
      );
      return;
    }
    const errorDetail = displayMsg ? `: ${displayMsg}` : "";
    const explicitRetryAfterMs = ("retryAfterMs" in lastMsg && typeof lastMsg.retryAfterMs === "number") ? lastMsg.retryAfterMs : undefined;

    // ── 1. Classify, preserving non-empty errorMessage precedence ──────
    const cls = classifyError(rawErrorMsg || displayMsg, explicitRetryAfterMs);

    // The provider can fail after gsd_task_complete has durably moved the
    // canonical Attempt to `verify`. Resolve the in-flight unit without
    // pausing so unit-phase can finish host verification and publication.
    const currentUnit = getAutoDashboardData().currentUnit;
    if (
      isTransient(cls) &&
      currentUnit &&
      isTaskExecutionReadyForHostVerification(currentUnit.type, currentUnit.id)
    ) {
      resetRetryState(retryState);
      resolveAgentEndCancelled({
        message: displayMsg || rawErrorMsg || "Transient provider error after durable Task completion",
        category: "provider",
        isTransient: true,
        retryAfterMs: "retryAfterMs" in cls ? cls.retryAfterMs : undefined,
      });
      return;
    }

    // ── 1a. Unsupported-model: provider rejected this model for the current
    //        account/plan at request time (#4513).  Persist a block so the
    //        same dead model isn't reselected on the next /gsd auto restart,
    //        then try a fallback before pausing.
    if (cls.kind === "unsupported-model") {
      const dash = getAutoDashboardData();
      const rejectedProvider = ctx.model?.provider;
      const rejectedId = ctx.model?.id;
      const blockedLabel = rejectedProvider && rejectedId ? `${rejectedProvider}/${rejectedId}` : "current model";
      await pauseForProviderModelRejection(ctx, pi, {
        errorDetail,
        rawErrorMsg,
        rejectedProvider,
        rejectedId,
        unitType: dash.currentUnit?.type,
        basePath: dash.basePath,
        blockReason: "unsupported for account",
        blockNotify: rejectedProvider && rejectedId
          ? `Blocked ${rejectedProvider}/${rejectedId} for this project — provider rejected it for the current account.`
          : "Blocked current model for this project.",
        switchedNotify: (label) => {
          ctx.ui.notify(
            `Switched to fallback ${label} after account entitlement rejection.`,
            "warning",
          );
        },
        buildPauseDetail: () =>
          `Model ${blockedLabel} blocked for this account${errorDetail}. Configure a different model and restart /gsd auto.`,
      });
      return;
    }

    // ── 1a2. Model-error: provider rejected the request payload for this model.
    //        Try fallbacks, then pause with prefs guidance. Do not persistently
    //        block the model: payload/schema bugs may be fixed without changing models.
    if (cls.kind === "model-error") {
      const dash = getAutoDashboardData();
      const rejectedProvider = ctx.model?.provider;
      const rejectedId = ctx.model?.id;
      const unitType = dash.currentUnit?.type;
      const modelConfig = unitType ? resolveModelWithFallbacksForUnit(unitType) : undefined;
      const guidance = resolveProviderErrorGuidance({
        errorMsg: displayMsg || rawErrorMsg,
        provider: rejectedProvider,
        modelId: rejectedId,
        unitType,
        preferencesPath: dash.basePath ? getProjectGSDPreferencesPath(dash.basePath) : undefined,
        hasConfiguredFallbacks: (modelConfig?.fallbacks.length ?? 0) > 0,
      });
      const guidanceText = formatGuidance(guidance);

      await pauseForProviderModelRejection(ctx, pi, {
        errorDetail,
        rawErrorMsg,
        rejectedProvider,
        rejectedId,
        unitType,
        basePath: dash.basePath,
        blockReason: "invalid request for model",
        blockNotify: rejectedProvider && rejectedId
          ? `Provider rejected ${rejectedProvider}/${rejectedId} request.`
          : "Provider rejected the current model request.",
        shouldBlockModel: false,
        switchedNotify: (label) => {
          ctx.ui.notify(`Switched to ${label} after provider request rejection.`, "warning");
        },
        buildPauseDetail: () =>
          `${guidanceText}${errorDetail ? `\n\nDetails${errorDetail}` : ""}`,
      });
      return;
    }

    // ── 1b. Defer to Core RetryHandler for most transient errors ────────
    // Core retries transient failures in-session after this handler. Its
    // explicit willRetry=false signal hands exhausted retries off to model
    // fallback; legacy events still use the rendered-prefix compatibility check.
    // Keep rate limits on model fallback logic below (#4373).
    if (
      event.willRetry !== false
      && shouldDeferTransientErrorToCoreRetry(cls, rawErrorMsg, rawErrorMsg || displayMsg)
    ) {
      return;
    }

    // ── Tool-schema overload: the active model repeatedly emitted tool-call
    //    arguments that fail schema validation (e.g. a model whose tool-call
    //    grammar can't satisfy GSD's schemas). Before hard-pausing, try the
    //    unit's configured fallbacks and the auto-mode start model — the model
    //    the user actually selected. This lets auto-mode recover by switching
    //    back to a schema-capable model instead of aborting outright (#813).
    //    Do not persistently block the model: schema-overload is request-shape
    //    specific, mirroring the model-error path above.
    if (cls.kind === "tool-schema") {
      const dash = getAutoDashboardData();
      const switched = await tryProviderModelFallback({
        ctx,
        pi,
        rejectedProvider: ctx.model?.provider,
        rejectedId: ctx.model?.id,
        basePath: dash.basePath,
        unitType: dash.currentUnit?.type,
        switchedNotify: (label) =>
          ctx.ui.notify(`Switched to ${label} after repeated tool schema validation failures.`, "warning"),
      });
      if (switched) return;

      await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
        message: `Tool schema error${errorDetail}`,
        category: "tool-schema",
        isTransient: false,
      }), {
        isRateLimit: false,
        isTransient: false,
        retryAfterMs: 0,
      });
      return;
    }

    // Cap rate-limit backoff for CLI-style providers (openai-codex, google-gemini-cli, google-antigravity)
    // which use per-user quotas with shorter windows (#2922).
    if (cls.kind === "rate-limit") {
      const currentProvider = ctx.model?.provider;
      if (
        currentProvider === "openai-codex"
        || currentProvider === "google-gemini-cli"
        || currentProvider === "google-antigravity"
      ) {
        cls.retryAfterMs = Math.min(cls.retryAfterMs, 30_000);
      }
      const dash = getAutoDashboardData();
      if (dash.basePath && ctx.model?.provider && ctx.model?.id) {
        blockModelUntil(
          dash.basePath,
          ctx.model.provider,
          ctx.model.id,
          Date.now() + cls.retryAfterMs,
          rawErrorMsg || displayMsg || "rate limit",
        );
      }
    }

    // ── 2. Decide & Act ──────────────────────────────────────────────────

    // --- Network errors: same-model retry with backoff ---
    if (cls.kind === "network") {
      const currentModelId = ctx.model?.id ?? "unknown";
      if (retryState.currentRetryModelId !== currentModelId) {
        retryState.networkRetryCount = 0;
        retryState.currentRetryModelId = currentModelId;
      }
      if (retryState.networkRetryCount < MAX_NETWORK_RETRIES) {
        retryState.networkRetryCount += 1;
        retryState.consecutiveTransientCount += 1;
        const attempt = retryState.networkRetryCount;
        const delayMs = attempt * cls.retryAfterMs;
        ctx.ui.notify(`Network error on ${currentModelId}${errorDetail}. Retry ${attempt}/${MAX_NETWORK_RETRIES} in ${delayMs / 1000}s...`, "warning");
        setTimeout(() => {
          pi.sendMessage(
            { customType: "gsd-auto-timeout-recovery", content: "Continue execution — retrying after transient network error.", display: false },
            { triggerTurn: true },
          );
        }, delayMs);
        return;
      }
      // Network retries exhausted — fall through to model fallback
      retryState.networkRetryCount = 0;
      retryState.currentRetryModelId = undefined;
      ctx.ui.notify(`Network retries exhausted for ${currentModelId}. Attempting model fallback.`, "warning");
    }

    // --- Transient errors: try model fallback first, then pause ---
    // Rate limits are often per-model, so switching models can bypass them.
    if (cls.kind === "rate-limit" || cls.kind === "network" || cls.kind === "server" || cls.kind === "connection" || cls.kind === "stream") {
      const dash = getAutoDashboardData();
      const switched = await tryProviderModelFallback({
        ctx,
        pi,
        rejectedProvider: ctx.model?.provider,
        rejectedId: ctx.model?.id,
        basePath: dash.basePath,
        unitType: dash.currentUnit?.type,
        switchedNotify: (label) => {
          retryState.networkRetryCount = 0;
          retryState.currentRetryModelId = undefined;
          ctx.ui.notify(`Model error${errorDetail}. Switched to fallback: ${label} and resuming.`, "warning");
        },
      });
      if (switched) {
        return;
      }
    }

    // Auto-mode owns bounded credential cooldowns at the loop boundary. Keep
    // the Task Attempt on its transient retry route instead of pausing the
    // session here, which can later be mistaken for a crashed executor.
    if (cls.kind === "rate-limit") {
      resolveAgentEndCancelled({
        message: `Provider error${errorDetail}`,
        category: "provider",
        isTransient: true,
        retryAfterMs: cls.retryAfterMs,
      });
      return;
    }

    // --- Transient fallback: pause with auto-resume ---
    // (rate-limit already returned above, so this is never a rate-limit pause)
    if (isTransient(cls)) {
      await pauseTransientWithBackoff(cls, pi, ctx, errorDetail, false);
      return;
    }

    // --- Permanent / unknown: pause indefinitely ---
    // Abort the live host turn: the supervisor is about to settle the running
    // Attempt as failed, and a host session that transparently retried the
    // failed request would otherwise keep executing against torn-down attempt
    // state (split-brain, #1973). The transient branch above deliberately does
    // NOT abort — it auto-resumes the same unit in the same session.
    await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
      message: `Provider error${errorDetail}`,
      category: "provider",
      isTransient: false,
    }, { abortActiveTurn: true }), {
      isRateLimit: false,
      isTransient: false,
      retryAfterMs: 0,
    });
    return;
  }

  // ── Success path ─────────────────────────────────────────────────────────
  try {
    resetRetryState(retryState);
    // #4573 — Reset the empty-turn counter on any successful agent turn so
    // transient stalls don't accumulate across independent units.
    resetEmptyTurnCounter();
    resolveAgentEnd(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Auto-mode error in agent_end handler: ${message}. Stopping auto-mode.`, "error");
    try {
      await pauseAuto(ctx, pi);
    } catch (e) {
      logWarning("bootstrap", `pauseAuto failed in agent_end handler: ${(e as Error).message}`);
    }
  }
}
