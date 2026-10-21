/**
 * Provider error handling tests — consolidated from:
 *   - provider-error-classify.test.ts (classifyError)
 *   - network-error-fallback.test.ts (isTransientNetworkError, getNextFallbackModel)
 *   - agent-end-provider-error.test.ts (pauseAutoForProviderError)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError, isTransient, isTransientNetworkError } from "../error-classifier.ts";
import { pauseAutoForProviderError } from "../provider-error-pause.ts";
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.ts";
import {
  MAX_TRANSIENT_AUTO_RESUMES,
  handleAgentEnd,
  isTerminalDeletedWorktreeProviderError,
  resetTransientRetryState,
  shouldDeferTransientErrorToCoreRetry,
  suppressTerminalDeletedWorktreeMessageEnd,
} from "../bootstrap/agent-end-recovery.ts";
import { blockModelUntil, clearTemporaryModelBlocksForTest } from "../blocked-models.ts";
import { _buildCancelledUnitStopReason } from "../auto/phase-helpers.ts";
import {
  _classifyZeroToolProviderMessageForTest,
  _zeroToolPseudoToolCallSnippetForTest,
} from "../auto/unit-phase.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { _resetPendingResolve, _setCurrentResolve } from "../auto/resolve.ts";
import { getNextFallbackModel } from "../preferences.ts";
import { clearGuidedUnitContext, getGuidedUnitContext, setGuidedUnitContext } from "../guided-unit-context.ts";
import { initNotificationStore, readNotifications, _resetNotificationStore } from "../notification-store.ts";
import { installNotifyInterceptor } from "../bootstrap/notify-interceptor.ts";
import { extractTrace } from "../session-forensics.ts";
// Zero-import module — imported by path rather than through the package
// barrel to avoid pulling the full AgentSession / @gsd/pi-ai dep graph into
// this unit test (see #4837).
import { streamOpenAICodexResponses } from "../../../../../packages/pi-ai/src/providers/openai-codex-responses.ts";

// ── classifyError ────────────────────────────────────────────────────────────

test("classifyError detects rate limit from 429", () => {
  const result = classifyError("HTTP 429 Too Many Requests");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

test("classifyError detects rate limit from message", () => {
  const result = classifyError("rate limit exceeded");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});

test("classifyError treats Anthropic quota-window phrasing as transient rate-limit (#4373)", () => {
  const result = classifyError("You've hit your limit · resets soon");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 60_000);
});

test("classifyError treats usage-limit phrasing as transient rate-limit (#4373)", () => {
  const result = classifyError("usage limit reached for this workspace");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});

test("zero-tool provider classifier treats Claude session-limit wording as transient rate-limit (#371)", () => {
  const result = _classifyZeroToolProviderMessageForTest("Claude Code session limit reached. Limit resets at 5 PM.");
  assert.ok(result, "session-limit wording should be recognized");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});

test("zero-tool provider classifier treats weekly limit wording as transient rate-limit (#371)", () => {
  const result = _classifyZeroToolProviderMessageForTest("You've reached your weekly limit. Try again later.");
  assert.ok(result, "weekly limit wording should be recognized");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});

test("zero-tool pseudo tool-call detector identifies serialization drift", () => {
  const snippet = _zeroToolPseudoToolCallSnippetForTest(
    'bash<arg_key>command</arg_key><arg_value>ls -la /tmp && echo "---SRC---"</arg_value></tool_call>',
  );
  assert.ok(snippet, "pseudo tool-call text should be recognized");
  assert.match(snippet, /bash<arg_key>command<\/arg_key>/);
});

test("zero-tool provider classifier does not treat pseudo tool-call text as an error class", () => {
  const result = _classifyZeroToolProviderMessageForTest(
    'bash<arg_key>command</arg_key><arg_value>ls -la /tmp && echo "---SRC---"</arg_value></tool_call>',
  );
  assert.equal(result, null, "pseudo tool-call text is drift, not a provider error");
});

test("classifyError treats extra-usage phrasing as transient rate-limit (#4397)", () => {
  const result = classifyError("You are out of extra usage. Please wait before retrying.");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 60_000);
});

test("classifyError treats OpenRouter affordability errors as transient rate-limit class", () => {
  const result = classifyError(
    "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329.",
  );
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

test("classifyError extracts reset delay from message", () => {
  const result = classifyError("rate limit exceeded, reset in 45s");
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 45000);
});

test("classifyError defaults to 60s for rate limit without reset", () => {
  const result = classifyError("429 too many requests");
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 60_000);
});

test("classifyError treats stream_exhausted_without_result as transient connection failure", () => {
  const result = classifyError("stream_exhausted_without_result");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError detects Anthropic internal server error", () => {
  const msg = '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"}}';
  const result = classifyError(msg);
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects Codex server_error from extracted message", () => {
  // After fix, mapCodexEvents extracts the nested error type and produces
  // "Codex server_error: <message>" instead of raw JSON.
  const msg = "Codex server_error: An error occurred while processing your request.";
  const result = classifyError(msg);
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects stream INTERNAL_ERROR received from peer as transient server", () => {
  const result = classifyError("stream error: stream ID 75; INTERNAL_ERROR; received from peer");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects overloaded error", () => {
  const result = classifyError("overloaded_error: Overloaded");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 30_000);
});

test("classifyError detects 503 service unavailable", () => {
  const result = classifyError("HTTP 503 Service Unavailable");
  assert.ok(isTransient(result));
});

test("classifyError detects 502 bad gateway", () => {
  const result = classifyError("HTTP 502 Bad Gateway");
  assert.ok(isTransient(result));
});

test("classifyError detects auth error as permanent", () => {
  const result = classifyError("unauthorized: invalid API key");
  assert.ok(!isTransient(result));
  assert.equal(result.kind, "permanent");
});

test("classifyError detects billing error as permanent", () => {
  const result = classifyError("billing issue: payment required");
  assert.ok(!isTransient(result));
});

test("classifyError detects quota exceeded as permanent", () => {
  const result = classifyError("quota exceeded for this month");
  assert.ok(!isTransient(result));
});

test("classifyError treats plain 'Connection error.' as transient connection failure (#3594)", () => {
  const result = classifyError("Connection error.");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError treats WebSocket transport errors as transient network failures (#338)", () => {
  for (const message of ["WebSocket error", "WebSocket disconnected", "web socket disconnected"]) {
    const result = classifyError(message);
    assert.ok(isTransient(result), `${message} should be transient`);
    assert.equal(result.kind, "network");
    assert.ok("retryAfterMs" in result && result.retryAfterMs === 3_000);
  }
});

test("classifyError treats unknown error as not transient", () => {
  const result = classifyError("something went wrong");
  assert.ok(!isTransient(result));
  assert.equal(result.kind, "unknown");
});

test("classifyError treats schema overload as tool-schema (non-transient)", () => {
  const result = classifyError("Schema overload: consecutive tool validation failures exceeded cap");
  assert.equal(result.kind, "tool-schema");
  assert.ok(!isTransient(result));
});

test("classifyError treats empty string as not transient", () => {
  const result = classifyError("");
  assert.ok(!isTransient(result));
});

test("classifyError: rate limit takes precedence over auth keywords", () => {
  const result = classifyError("429 unauthorized rate limit");
  assert.equal(result.kind, "rate-limit");
  assert.ok(isTransient(result));
});

// ── unsupported-model: account/plan entitlement rejection (#4513) ──────────

test("classifyError: Codex ChatGPT-account entitlement rejection is unsupported-model", () => {
  const result = classifyError(
    "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
  );
  assert.equal(result.kind, "unsupported-model");
  assert.ok(!isTransient(result));
});

test("classifyError: 'model not available for this plan' is unsupported-model", () => {
  const result = classifyError("This model is not available for your current plan.");
  assert.equal(result.kind, "unsupported-model");
});

test("classifyError: 'account does not have access to model' is unsupported-model", () => {
  const result = classifyError("Your account does not have access to the gpt-5 model.");
  assert.equal(result.kind, "unsupported-model");
});

test("classifyError: 'tier does not support deployment' is unsupported-model", () => {
  const result = classifyError("The free tier does not support this deployment.");
  assert.equal(result.kind, "unsupported-model");
});

test("classifyError: 'account suspended' stays permanent (not unsupported-model)", () => {
  const result = classifyError("Your account has been suspended. Contact support.");
  assert.equal(result.kind, "permanent");
});

test("classifyError: 'invalid account' stays permanent", () => {
  const result = classifyError("invalid account credentials");
  assert.equal(result.kind, "permanent");
});

test("classifyError: rate limit on unsupported-model phrasing stays rate-limit", () => {
  // A throttled account is not an entitlement failure.
  const result = classifyError(
    "429 rate limit — model not supported when using your account right now",
  );
  assert.equal(result.kind, "rate-limit");
});

// ── STREAM_RE: V8 JSON parse error variants (#2916) ────────────────────────

test("classifyError: 'Expected comma/brace after property value in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected ',' or '}' after property value in JSON at position 2056 (line 1 column 2057)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError: 'Expected colon after property name in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected ':' after property name in JSON at position 500 (line 1 column 501)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError: 'Expected property name or brace in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected property name or '}' in JSON at position 42 (line 1 column 43)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

test("classifyError: 'Unterminated string in JSON' is transient stream", () => {
  const result = classifyError(
    "Unterminated string in JSON at position 100 (line 1 column 101)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15_000);
});

// ── isTransientNetworkError ──────────────────────────────────────────────────

test("isTransientNetworkError detects ECONNRESET", () => {
  assert.ok(isTransientNetworkError("fetch failed: ECONNRESET"));
});

test("isTransientNetworkError detects ETIMEDOUT", () => {
  assert.ok(isTransientNetworkError("ETIMEDOUT: request timed out"));
});

test("isTransientNetworkError detects generic network error", () => {
  assert.ok(isTransientNetworkError("network error"));
});

test("isTransientNetworkError detects socket hang up", () => {
  assert.ok(isTransientNetworkError("socket hang up"));
});

test("isTransientNetworkError detects WebSocket transport errors", () => {
  assert.ok(isTransientNetworkError("WebSocket error"));
});

test("isTransientNetworkError detects fetch failed", () => {
  assert.ok(isTransientNetworkError("fetch failed"));
});

test("isTransientNetworkError detects connection reset", () => {
  assert.ok(isTransientNetworkError("connection was reset by peer"));
});

test("isTransientNetworkError detects DNS errors", () => {
  assert.ok(isTransientNetworkError("dns resolution failed"));
});

test("isTransientNetworkError detects unexpected EOF", () => {
  assert.ok(isTransientNetworkError("unexpected EOF"));
});

test("isTransientNetworkError rejects auth errors", () => {
  assert.ok(!isTransientNetworkError("unauthorized: invalid API key"));
});

test("isTransientNetworkError rejects quota errors", () => {
  assert.ok(!isTransientNetworkError("quota exceeded"));
});

test("isTransientNetworkError rejects billing errors", () => {
  assert.ok(!isTransientNetworkError("billing issue: network payment required"));
});

test("isTransientNetworkError rejects empty string", () => {
  assert.ok(!isTransientNetworkError(""));
});

test("isTransientNetworkError rejects non-network errors", () => {
  assert.ok(!isTransientNetworkError("model not found"));
});

// ── getNextFallbackModel ─────────────────────────────────────────────────────

test("getNextFallbackModel selects next fallback if current is a fallback", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-b", modelConfig), "model-c");
});

test("getNextFallbackModel returns undefined if fallbacks exhausted", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-c", modelConfig), undefined);
});

test("getNextFallbackModel finds current model with provider prefix", () => {
  const modelConfig = { primary: "p/model-a", fallbacks: ["p/model-b"] };
  assert.equal(getNextFallbackModel("model-a", modelConfig), "p/model-b");
});

test("getNextFallbackModel returns primary if current is unknown", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-x", modelConfig), "model-a");
});

test("getNextFallbackModel returns primary if current is undefined", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel(undefined, modelConfig), "model-a");
});

// ── pauseAutoForProviderError ────────────────────────────────────────────────

test("pauseAutoForProviderError warns and pauses without requiring ctx.log", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
    ": terminated",
    async () => { pauseCalls += 1; },
  );

  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    { message: "Auto-mode paused due to provider error: terminated", level: "warning" },
  ]);
});

test("pauseAutoForProviderError schedules auto-resume for rate limit errors", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;
  let resumeCalled = false;

  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    timers.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    await pauseAutoForProviderError(
      { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
      ": rate limit exceeded",
      async () => { pauseCalls += 1; },
      { isRateLimit: true, retryAfterMs: 90000, resume: () => { resumeCalled = true; } },
    );

    assert.equal(pauseCalls, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 90000);
    assert.deepEqual(notifications[0], {
      message: "Rate limited: rate limit exceeded. Auto-resuming in 90s...",
      level: "warning",
    });

    timers[0].fn();
    assert.equal(resumeCalled, true);
    assert.deepEqual(notifications[1], {
      message: "Rate limit window elapsed. Resuming auto-mode.",
      level: "info",
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pauseAutoForProviderError schedules auto-resume for WebSocket network errors", async () => {
  const cls = classifyError("WebSocket error");
  if (cls.kind !== "network") {
    assert.fail(`expected WebSocket error to classify as network, got ${cls.kind}`);
  }

  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;
  let resumeCalled = false;

  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    timers.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    await pauseAutoForProviderError(
      { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
      ": WebSocket error",
      async () => { pauseCalls += 1; },
      { isTransient: isTransient(cls), retryAfterMs: cls.retryAfterMs, resume: () => { resumeCalled = true; } },
    );

    assert.equal(pauseCalls, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 3_000);
    assert.deepEqual(notifications[0], {
      message: "Server error (transient): WebSocket error. Auto-resuming in 3s...",
      level: "warning",
    });

    timers[0].fn();
    assert.equal(resumeCalled, true);
    assert.deepEqual(notifications[1], {
      message: "Server error recovery delay elapsed. Resuming auto-mode.",
      level: "info",
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pauseAutoForProviderError falls back to indefinite pause when not rate limit", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let pauseCalls = 0;

  await pauseAutoForProviderError(
    { notify(message, level?) { notifications.push({ message, level: level ?? "info" }); } },
    ": connection refused",
    async () => { pauseCalls += 1; },
    { isRateLimit: false },
  );

  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    { message: "Auto-mode paused due to provider error: connection refused", level: "warning" },
  ]);
});

test("agent_end retries when empty errorMessage has stream failure in content (#956)", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const notifications: Array<{ message: string; level?: string }> = [];
  const sendMessageCalls: unknown[][] = [];
  const timers: Array<{ fn: () => void; delay: number }> = [];

  resetTransientRetryState();
  autoSession.reset();
  // handleAgentEnd returns at the isAutoActive() guard unless auto-mode is
  // active. Set the minimum fields needed to reach the stopReason === "error"
  // branch without requiring a real DB or worktree.
  autoSession.active = true;
  autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    timers.push({ fn, delay: delay ?? 0 });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    await handleAgentEnd({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
      },
    } as any, {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "",
        content: [{ type: "text", text: "API Error: stream idle timeout - partial response received" }],
      }],
    } as any, {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      ui: {
        notify(message: string, level?: "info" | "warning" | "error" | "success") {
          notifications.push({ message, level });
        },
      },
    } as any);

    assert.equal(timers.length, 1, "empty errorMessage stream failures should use the network retry path");
    assert.equal(timers[0].delay, 3_000);
    assert.deepEqual(notifications[0], {
      message: "Network error on gpt-5.5: API Error: stream idle timeout - partial response received. Retry 1/2 in 3s...",
      level: "warning",
    });

    timers[0].fn();
    assert.equal(sendMessageCalls.length, 1);
    assert.deepEqual(sendMessageCalls[0][1], { triggerTurn: true });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    resetTransientRetryState();
    autoSession.reset();
  }
});

test("rate-limit agent_end walks past unavailable fallback models before pausing (#716 follow-up)", async () => {
  const originalCwd = process.cwd();
  const originalSetTimeout = globalThis.setTimeout;
  const base = mkdtempSync(join(tmpdir(), "gsd-rate-limit-agent-end-"));
  const notifications: Array<{ message: string; level?: string }> = [];
  const setModelCalls: string[] = [];
  const sendMessageCalls: unknown[][] = [];
  const timers: Array<{ delay: number }> = [];

  globalThis.setTimeout = ((_fn: (...args: unknown[]) => void, delay?: number) => {
    if ((delay ?? 0) === 0) {
      // delay-0 is a macrotask deferral (scheduleFallbackContinuation): invoke
      // immediately in tests so sendMessage assertions can fire synchronously.
      _fn();
    } else {
      // delay>0 is a pause/backoff timer: capture without firing so the test
      // stays synchronous and can assert no pause was scheduled.
      timers.push({ delay: delay ?? 0 });
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    clearTemporaryModelBlocksForTest();
    autoSession.reset();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  execution:",
        "    model: gpt-5.5",
        "    provider: openai-codex",
        "    fallbacks:",
        "      - anthropic/claude-sonnet-4-6",
        "      - google-gemini-cli/gemini-2.5-pro",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.chdir(base);

    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
    autoSession.autoModeStartModel = { provider: "openai-codex", id: "gpt-5.5" };

    blockModelUntil(base, "anthropic", "claude-sonnet-4-6", Date.now() + 60_000, "fallback also limited");

    const availableModels = [
      { id: "gpt-5.5", provider: "openai-codex", api: "responses" },
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "gemini-2.5-pro", provider: "google-gemini-cli", api: "google-genai" },
    ];
    const ctx = {
      model: availableModels[0],
      modelRegistry: { getAvailable: () => availableModels },
      ui: {
        notify(message: string, level?: "info" | "warning" | "error" | "success") {
          notifications.push({ message, level });
        },
        setStatus: () => {},
        setWidget: () => {},
        setWorkingMessage: () => {},
      },
    } as any;
    const pi = {
      setModel: async (model: { provider: string; id: string }) => {
        setModelCalls.push(`${model.provider}/${model.id}`);
        return true;
      },
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
      },
    } as any;

    await handleAgentEnd(pi, {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "You've hit your session limit · resets 7:20 pm (Europe/Rome)",
      }],
    } as any, ctx);

    assert.deepEqual(setModelCalls, ["google-gemini-cli/gemini-2.5-pro"]);
    assert.equal(sendMessageCalls.length, 1, "fallback recovery must trigger a deferred continuation turn");
    assert.deepEqual(sendMessageCalls[0][1], { triggerTurn: true }, "continuation must use plain triggerTurn — no deliverAs:steer — to start a fresh turn, not steer the dying one");
    assert.equal(timers.length, 0, "must not schedule a delay-backoff pause timer when a fallback is available");
    assert.ok(
      notifications.some((n) => n.message.includes("google-gemini-cli/gemini-2.5-pro")),
      "user-facing notification should name the fallback actually selected",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    process.chdir(originalCwd);
    clearTemporaryModelBlocksForTest();
    autoSession.reset();
    rmSync(base, { recursive: true, force: true });
  }
});

test("usage-limit agent_end resolves a credential-cooldown cancellation without pausing auto-mode", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-usage-limit-cooldown-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  try {
    process.chdir(base);
    autoSession.reset();
    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
    const resultPromise = new Promise<any>((resolve) => _setCurrentResolve(resolve));

    await handleAgentEnd({
      setModel: async () => false,
    } as any, {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "Codex usage_limit_reached: The usage limit has been reached",
        retryAfterMs: 30_000,
      }],
    } as any, {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      modelRegistry: { getAvailable: () => [] },
      ui: { notify: () => {} },
    } as any);

    const result = await resultPromise;
    assert.equal(autoSession.active, true, "provider recovery must leave loop-owned cooldown active");
    assert.deepEqual(result, {
      status: "cancelled",
      errorContext: {
        message: "Provider error: Codex usage_limit_reached: The usage limit has been reached",
        category: "provider",
        isTransient: true,
        retryAfterMs: 30_000,
      },
    });
  } finally {
    _resetPendingResolve();
    autoSession.reset();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("transient provider-error pause message has a single colon (#2227)", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay?: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    timers.push({ fn, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    _resetPendingResolve();
    resetTransientRetryState();
    autoSession.reset();
  });

  resetTransientRetryState();
  autoSession.reset();
  autoSession.active = true;
  autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
  const resultPromise = new Promise<any>((resolve) => _setCurrentResolve(resolve));

  // No basePath on the session, so tryProviderModelFallback short-circuits
  // and the exhausted transient error falls through to pauseTransientWithBackoff.
  await handleAgentEnd({
    sendMessage: () => {},
  } as any, {
    willRetry: false,
    messages: [{
      role: "assistant",
      stopReason: "error",
      errorMessage: "Connection error.",
    }],
  } as any, {
    model: { provider: "openai-codex", id: "gpt-5.5" },
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingMessage: () => {},
    },
  } as any);

  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext.category, "provider");
  assert.equal(result.errorContext.isTransient, true);
  assert.equal(
    result.errorContext.message,
    "Provider error: Connection error.",
    "pause message must contain exactly one colon-space (#2227)",
  );
  assert.equal(timers.length, 1, "transient pause schedules exactly one auto-resume timer");
});

test("retry-exhausted transient provider errors trigger model fallback (#1364, #2031)", async () => {
  const originalCwd = process.cwd();
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number) => {
    if ((delay ?? 0) === 0) {
      fn();
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    for (const { reason, errorMessage, willRetry } of [
      {
        reason: "abort",
        errorMessage: "Retry failed after 3 attempts: Unhandled stop reason: abort",
        willRetry: undefined,
      },
      {
        reason: "unknown",
        errorMessage: "Retry failed after 3 attempts: Unhandled stop reason: unknown",
        willRetry: undefined,
      },
      {
        reason: "no_available_providers",
        errorMessage: '503 {"error":{"type":"no_available_providers","message":"No available providers"}}',
        willRetry: false,
      },
    ]) {
      const base = mkdtempSync(join(tmpdir(), `gsd-stop-reason-${reason}-`));
      const notifications: Array<{ message: string; level?: string }> = [];
      const setModelCalls: string[] = [];
      const sendMessageCalls: unknown[][] = [];

      try {
        resetTransientRetryState();
        clearTemporaryModelBlocksForTest();
        autoSession.reset();
        mkdirSync(join(base, ".gsd"), { recursive: true });
        writeFileSync(
          join(base, ".gsd", "PREFERENCES.md"),
          [
            "---",
            "models:",
            "  execution:",
            "    model: gpt-5.5",
            "    provider: openai-codex",
            "    fallbacks:",
            "      - anthropic/claude-sonnet-4-6",
            "---",
          ].join("\n"),
          "utf-8",
        );
        process.chdir(base);

        autoSession.active = true;
        autoSession.basePath = base;
        autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
        autoSession.autoModeStartModel = { provider: "openai-codex", id: "gpt-5.5" };

        const availableModels = [
          { id: "gpt-5.5", provider: "openai-codex", api: "responses" },
          { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
        ];
        const ctx = {
          model: availableModels[0],
          modelRegistry: { getAvailable: () => availableModels },
          ui: {
            notify(message: string, level?: "info" | "warning" | "error" | "success") {
              notifications.push({ message, level });
            },
            setStatus: () => {},
            setWidget: () => {},
            setWorkingMessage: () => {},
          },
        } as any;
        const pi = {
          setModel: async (model: { provider: string; id: string }) => {
            setModelCalls.push(`${model.provider}/${model.id}`);
            return true;
          },
          sendMessage: (...args: unknown[]) => {
            sendMessageCalls.push(args);
          },
        } as any;

        await handleAgentEnd(pi, {
          willRetry,
          messages: [{
            role: "assistant",
            stopReason: "error",
            errorMessage,
          }],
        } as any, ctx);

        assert.deepEqual(setModelCalls, ["anthropic/claude-sonnet-4-6"], `${reason} should switch to configured fallback`);
        assert.equal(sendMessageCalls.length, 1, `${reason} fallback recovery must trigger a continuation turn`);
        assert.deepEqual(sendMessageCalls[0][1], { triggerTurn: true });
        assert.ok(
          notifications.some((n) => n.message.includes("anthropic/claude-sonnet-4-6")),
          `${reason} notification should name the selected fallback`,
        );
      } finally {
        process.chdir(originalCwd);
        clearTemporaryModelBlocksForTest();
        resetTransientRetryState();
        autoSession.reset();
        rmSync(base, { recursive: true, force: true });
      }
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    process.chdir(originalCwd);
    clearTemporaryModelBlocksForTest();
    resetTransientRetryState();
    autoSession.reset();
  }
});

test("isTerminalDeletedWorktreeProviderError matches removed auto-worktree paths only", () => {
  assert.equal(
    isTerminalDeletedWorktreeProviderError('Path "/Users/dev/.gsd/projects/abc123/worktrees/M005" does not exist'),
    true,
  );
  assert.equal(
    isTerminalDeletedWorktreeProviderError('Path "/Users/dev/app/.gsd/worktrees/M005" does not exist'),
    true,
  );
  assert.equal(
    isTerminalDeletedWorktreeProviderError('Path "/Users/dev/app/src/file.ts" does not exist'),
    false,
  );
  assert.equal(
    isTerminalDeletedWorktreeProviderError('Path "/Users/dev/.gsd/projects/abc123/worktrees/M005" failed with EACCES'),
    false,
  );
});

test("suppresses terminal completion deleted-worktree message before it renders", () => {
  autoSession.reset();
  autoSession.completionStopInProgress = true;
  try {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: 'Path "/Users/dev/.gsd/projects/abc123/worktrees/M005" does not exist',
        content: [],
      },
    } as any;

    assert.equal(suppressTerminalDeletedWorktreeMessageEnd(event), true);
    assert.equal(event.message.stopReason, "completed");
    assert.equal(event.message.errorMessage, undefined);
    assert.deepEqual(event.message.content, []);
  } finally {
    autoSession.reset();
  }
});

test("does not suppress deleted-worktree provider errors outside terminal completion", () => {
  autoSession.reset();
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: 'Path "/Users/dev/.gsd/projects/abc123/worktrees/M005" does not exist',
      content: [],
    },
  } as any;

  assert.equal(suppressTerminalDeletedWorktreeMessageEnd(event), false);
  assert.equal(event.message.stopReason, "error");
});

test("manual guided discuss provider error records warning and activity marker (#944)", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-manual-discuss-error-"));
  const notifications: Array<{ message: string; level?: string }> = [];
  const sendMessageCalls: unknown[][] = [];

  try {
    autoSession.reset();
    mkdirSync(join(base, ".git"), { recursive: true });
    mkdirSync(join(base, ".gsd"), { recursive: true });
    process.chdir(base);
    initNotificationStore(base);

    // Use base as the guided context path so gsdRoot(base) hits the fast path
    // (.gsd exists at base directly) and doesn't need git to walk up from a
    // subdirectory — the empty .git folder is not a real repo and git resolution
    // from a child directory would return the wrong .gsd path.
    setGuidedUnitContext(base, "discuss-slice");

    const ctx = {
      model: { provider: "openai-codex", id: "gpt-5.1-codex" },
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify(message: string, level?: "info" | "warning" | "error" | "success") {
          notifications.push({ message, level });
        },
      },
    } as any;
    installNotifyInterceptor(ctx);

    const pi = {
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
      },
    } as any;

    await handleAgentEnd(pi, {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "",
        content: [{ type: "text", text: "stream idle timeout while saving summary" }],
      }],
    } as any, ctx);

    assert.deepEqual(sendMessageCalls, [], "manual discuss terminal errors must not auto-retry or redispatch");
    assert.equal(getGuidedUnitContext(base), null, "guided unit context must still be cleared after the turn");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Manual \/gsd discuss discuss-slice ended with a provider error/);
    assert.match(notifications[0]?.message ?? "", /openai-codex\/gpt-5\.1-codex/);
    assert.match(notifications[0]?.message ?? "", /stream idle timeout/);

    const persisted = readNotifications(base);
    assert.equal(persisted.length, 1, "wrapped notify should persist exactly one warning notification");
    assert.equal(persisted[0]?.severity, "warning");
    assert.equal(persisted[0]?.source, "notify");

    const activityDir = join(base, ".gsd", "activity");
    const files = readdirSync(activityDir).filter((file) => file.endsWith(".jsonl"));
    assert.equal(files.length, 1, "manual guided provider error should write one activity marker");
    const entries = readFileSync(join(activityDir, files[0]!), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1);
    assert.match(trace.errors[0] ?? "", /discuss-slice/);
    assert.match(trace.errors[0] ?? "", /openai-codex\/gpt-5\.1-codex/);
    assert.match(trace.errors[0] ?? "", /stream idle timeout/);
  } finally {
    clearGuidedUnitContext();
    _resetNotificationStore();
    autoSession.reset();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("manual guided discuss user-cancel is not treated as a provider error (#944)", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-manual-discuss-cancel-"));
  const guidedBase = join(base, "slice-work");
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    autoSession.reset();
    mkdirSync(join(base, ".git"), { recursive: true });
    mkdirSync(join(base, ".gsd"), { recursive: true });
    mkdirSync(guidedBase, { recursive: true });
    process.chdir(base);
    initNotificationStore(base);

    setGuidedUnitContext(guidedBase, "discuss-slice");

    const ctx = {
      model: { provider: "anthropic", id: "claude-opus-4" },
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify(message: string, level?: "info" | "warning" | "error" | "success") {
          notifications.push({ message, level });
        },
      },
    } as any;
    installNotifyInterceptor(ctx);

    const pi = { sendMessage: () => {} } as any;

    await handleAgentEnd(pi, {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "Request aborted by user",
        content: [],
      }],
    } as any, ctx);

    assert.deepEqual(notifications, [], "user-cancel stopReason=error must not emit a provider-error warning");
    assert.equal(getGuidedUnitContext(guidedBase), null, "context must be cleared even for user-cancel");

    // No activity directory should have been created
    let activityExists = false;
    try { readdirSync(join(base, ".gsd", "activity")); activityExists = true; } catch { /* expected */ }
    assert.equal(activityExists, false, "user-cancel must not write an activity error marker");
  } finally {
    clearGuidedUnitContext();
    _resetNotificationStore();
    autoSession.reset();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

// ── resumeAutoAfterProviderDelay ────────────────────────────────────────────

test("resumeAutoAfterProviderDelay restarts paused auto-mode from the recorded base path", async () => {
  const startCalls: Array<{ base: string; verboseMode: boolean; step?: boolean }> = [];
  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: true,
        basePath: "/tmp/project",
      }),
      resetTransientRetryState: () => {},
      startAuto: async (_ctx, _pi, base, verboseMode, options) => {
        startCalls.push({ base, verboseMode, step: options?.step });
      },
    },
  );

  assert.equal(result, "resumed");
  assert.deepEqual(startCalls, [
    { base: "/tmp/project", verboseMode: false, step: true },
  ]);
});

test("resumeAutoAfterProviderDelay does not double-start when auto-mode is already active", async () => {
  let startCalls = 0;
  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({
        active: true,
        paused: false,
        stepMode: false,
        basePath: "/tmp/project",
      }),
      resetTransientRetryState: () => {},
      startAuto: async () => {
        startCalls += 1;
      },
    },
  );

  assert.equal(result, "already-active");
  assert.equal(startCalls, 0);
});

test("resumeAutoAfterProviderDelay leaves auto paused when no base path is available", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  let startCalls = 0;

  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    {
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level: level ?? "info" });
        },
      },
    } as any,
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: false,
        basePath: "",
      }),
      resetTransientRetryState: () => {},
      startAuto: async () => {
        startCalls += 1;
      },
    },
  );

  assert.equal(result, "missing-base");
  assert.equal(startCalls, 0);
  assert.deepEqual(notifications, [
    {
      message: "Provider error recovery delay elapsed, but no paused auto-mode base path was available. Leaving auto-mode paused.",
      level: "warning",
    },
  ]);
});

test("resumeAutoAfterProviderDelay resets provider retry state without clearing session-timeout attempts", async () => {
  const calls: string[] = [];

  const result = await resumeAutoAfterProviderDelay(
    {} as any,
    { ui: { notify() {} } } as any,
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: false,
        basePath: "/tmp/project",
      }),
      resetTransientRetryState: () => {
        calls.push("reset-transient");
      },
      startAuto: async () => {
        calls.push("start-auto");
      },
    },
  );

  assert.equal(result, "resumed");
  assert.deepEqual(calls, [
    "reset-transient",
    "start-auto",
  ]);
});

// ── Provider recovery behavior (#1166 / #2813 / #4373) ─────────────────────

test("resetTransientRetryState is callable by resume recovery", () => {
  resetTransientRetryState();
  assert.equal(classifyError("stream_exhausted_without_result").kind, "connection");
});

test("cancelled unit stop reason differentiates session startup failures", () => {
  assert.deepEqual(
    _buildCancelledUnitStopReason("plan-slice", "S01", {
      category: "session-failed",
      message: "Session creation timed out",
    }),
    {
      notifyMessage: "Session creation failed for plan-slice S01: Session creation timed out. Stopping auto-mode.",
      stopReason: "Session creation failed: Session creation timed out",
      loopReason: "session-failed",
    },
  );

  assert.deepEqual(
    _buildCancelledUnitStopReason("execute-task", "T01", {
      category: "aborted",
      message: "Request aborted by user",
    }),
    {
      notifyMessage: "Unit execute-task T01 aborted after dispatch: Request aborted by user. Stopping auto-mode.",
      stopReason: "Unit aborted: Request aborted by user",
      loopReason: "unit-aborted",
    },
  );
});

test("openai-codex response stream surfaces nested error type and message", async () => {
  const originalFetch = globalThis.fetch;
  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  })).toString("base64");
  const apiKey = `header.${tokenPayload}.signature`;
  globalThis.fetch = (async () => new Response(
    'data: {"type":"error","error":{"type":"server_error","code":"server_error","message":"upstream failed"}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )) as typeof fetch;

  try {
    const stream = streamOpenAICodexResponses(
      {
        provider: "openai-codex-responses",
        id: "gpt-5.1-codex",
        baseUrl: "https://codex.example.test",
      } as any,
      { messages: [], systemPrompt: "", tools: [] } as any,
      { apiKey } as any,
    );

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errorEvent = events.find((event) => event.type === "error");
    assert.ok(errorEvent, "stream should emit an error event");
    assert.equal(errorEvent.error.errorMessage, "Codex server_error: upstream failed");
    assert.equal(classifyError(errorEvent.error.errorMessage).kind, "server");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Fix 3: MAX_TRANSIENT_AUTO_RESUMES raised to 8 ───────────────────────────

test("MAX_TRANSIENT_AUTO_RESUMES is at least 8 for sustained overload resilience", () => {
  // Import the real constant rather than regex-scraping the source literal —
  // this way the assertion cannot silently drift if the symbol is renamed or
  // the value is moved. See #4837.
  assert.ok(
    MAX_TRANSIENT_AUTO_RESUMES >= 8,
    `MAX_TRANSIENT_AUTO_RESUMES must be >= 8 for sustained overload resilience, got ${MAX_TRANSIENT_AUTO_RESUMES}`,
  );
});

// ── OpenAI-completions mid-stream cut (#577) ─────────────────────────────────

test("classifyError: 'Stream ended without finish_reason' is transient network (#577)", () => {
  const result = classifyError("Stream ended without finish_reason");
  assert.ok(isTransient(result), "Stream ended without finish_reason must be transient");
  assert.equal(result.kind, "network");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

// ── Stream idle timeout / partial response (#4558) ──────────────────────────

test("classifyError: 'Stream idle timeout - partial response received' is transient network", () => {
  const result = classifyError("API Error: Stream idle timeout - partial response received");
  assert.ok(isTransient(result), "stream idle timeout must be transient");
  assert.equal(result.kind, "network");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});

test("classifyError: 'stream idle timeout' (lowercase) is transient network", () => {
  const result = classifyError("stream idle timeout");
  assert.ok(isTransient(result), "lowercase stream idle timeout must be transient");
  assert.equal(result.kind, "network");
});

test("classifyError: 'partial response received' alone is transient network", () => {
  const result = classifyError("partial response received");
  assert.ok(isTransient(result), "partial response received must be transient");
  assert.equal(result.kind, "network");
});

// ── Bare status-only 400 (no diagnostic body) ────────────────────────────────
// Observed 2026-09-11: GitHub Copilot's model router rejected an otherwise-valid
// kimi-k3 request with a status-only "400 Bad Request" and empty body; the same
// session succeeded on retry. The status-only form must be transient (bounded
// same-model retry), not the `unknown` hard-pause.

test("classifyError treats a status-only '400 Bad Request' as transient network", () => {
  for (const message of ["400 Bad Request", "400 Bad Request\n", "  400  Bad Request  "]) {
    const result = classifyError(message);
    assert.ok(isTransient(result), `${JSON.stringify(message)} must be transient`);
    assert.equal(result.kind, "network");
  }
});

// Regression (2026-09-11): when the turn's errorMessage is empty/useless the
// recovery path classifies the assistant content text, which arrives with the
// provider adapter's "Provider error:" prefix baked in ("Provider error: 400 Bad
// Request\n"). The anchored bare-400 regex must tolerate that wrapper (and the
// adapter's "Provider error: : …" stray-colon form) or the status-only 400 falls
// through to `unknown` and hard-pauses auto-mode — the exact wedge W-a8123253.
test("classifyError treats a provider-prefixed status-only '400 Bad Request' as transient network", () => {
  for (const message of [
    "Provider error: 400 Bad Request",
    "Provider error: 400 Bad Request\n",
    "Provider error: : 400 Bad Request",
    ": 400 Bad Request",
  ]) {
    const result = classifyError(message);
    assert.ok(isTransient(result), `${JSON.stringify(message)} must be transient`);
    assert.equal(result.kind, "network");
  }
});

test("classifyError keeps 400 with diagnostic body on the non-transient path", () => {
  // Known request-shape rejection phrasing stays model-error (fallback-eligible).
  const withInvalidParams = classifyError('400 {"error":{"message":"invalid params: max_tokens"}}');
  assert.equal(withInvalidParams.kind, "model-error");
  // An unrecognized 400 body keeps the conservative unknown pause.
  const unknown400 = classifyError('400 {"error":{"message":"some unrecognized rejection"}}');
  assert.equal(unknown400.kind, "unknown");
  assert.ok(!isTransient(unknown400), "400 with body must not be auto-retried");
});

test("classifyError keeps bare 401/403 status lines permanent", () => {
  assert.equal(classifyError("401 Unauthorized").kind, "permanent");
  assert.equal(classifyError("403 Forbidden").kind, "permanent");
});

// ── Context overflow / context window exceeded (#4528) ───────────────────────

test("classifyError: MiniMax context window error is transient server", () => {
  const result = classifyError("400 invalid params, context window exceeds limit (2013)");
  assert.ok(isTransient(result), "context window exceeded must be transient");
  assert.equal(result.kind, "server");
});

test("classifyError: 'context length exceeded' is transient server", () => {
  const result = classifyError("context length exceeded: max 128000 tokens");
  assert.ok(isTransient(result), "context length exceeded must be transient");
  assert.equal(result.kind, "server");
});

test("classifyError: 'context window' with 'exceed' is transient server", () => {
  const result = classifyError("context window exceeded for this model");
  assert.ok(isTransient(result), "context window exceeded must be transient");
  assert.equal(result.kind, "server");
});

// ── provider retry classification handles server_error (#1166) ──────────────

test("classifyError treats server_error/internal_error variants as transient server failures", () => {
  const retryableMessages = [
    "Codex server_error: An error occurred",
    "server error occurred",
    "internal_error: something went wrong",
    "internal error",
  ];

  for (const message of retryableMessages) {
    const result = classifyError(message);
    assert.ok(isTransient(result), `${message} should be treated as transient`);
    assert.equal(result.kind, "server");
  }

  assert.notEqual(classifyError("model not found").kind, "server");
  assert.notEqual(classifyError("temporarily backed off").kind, "server");
});

test("exhausted retry errors are not deferred back to core retry handling", () => {
  const cls = classifyError("Retry failed after 3 attempts: 500 empty_stream: upstream stream closed before first payload");
  assert.equal(cls.kind, "server");
  assert.equal(
    shouldDeferTransientErrorToCoreRetry(
      cls,
      "Retry failed after 3 attempts: 500 empty_stream: upstream stream closed before first payload",
    ),
    false,
  );
});

// ── no-api-key: request-time auth failure is fallback-eligible (#1533) ──────

test("classifyError treats 'No API key for provider' as fallback-eligible model-error (#1533)", () => {
  // Provider adapters throw this at request time when a stored credential is
  // expired/unrefreshable — selection-time hasAuth() passed, but no usable key
  // materialized. This must NOT classify as unknown (which bypasses the
  // configured fallback chain and pauses indefinitely); model-error routes
  // through the fallback-attempting branch in agent-end-recovery.ts.
  const messages = [
    "No API key for provider: openai-codex",
    "No API key for provider: anthropic",
    "No API key for provider: google",
    "No API key available for provider: openrouter",
    "No API key found for openai",
    "No API key for openai-codex/gpt-5.4",
  ];
  for (const message of messages) {
    const result = classifyError(message);
    assert.equal(result.kind, "model-error", `${message} should classify as model-error`);
    assert.ok(!isTransient(result), `${message} should not be same-model transient`);
  }
});

test("classifyError keeps explicit auth failures permanent even with API-key phrasing (#1533)", () => {
  // Genuine auth rejections must not become fallback-eligible just because the
  // message also mentions an API key.
  const result = classifyError("401 unauthorized: No API key for provider: openai-codex");
  assert.equal(result.kind, "permanent");
});

test("model-error branch in agent-end-recovery attempts fallback before any terminal pause (#1533)", () => {
  // Structural: the model-error handler must exist, must try fallbacks via
  // pauseForProviderModelRejection without persistently blocking the model,
  // and must precede the terminal unknown/permanent pause that bypasses
  // fallback (pauseAutoForProviderError with isTransient: false).
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "bootstrap", "agent-end-recovery.ts"),
    "utf-8",
  );
  const modelErrorMatch = /cls\.kind\s*===\s*["']model-error["']/.exec(src);
  assert.ok(modelErrorMatch, "agent-end-recovery.ts must handle cls.kind model-error");
  const modelErrorIdx = modelErrorMatch.index;
  const rejectionCallIdx = src.indexOf("pauseForProviderModelRejection", modelErrorIdx);
  assert.ok(rejectionCallIdx > 0, "model-error branch must call pauseForProviderModelRejection");
  // Anchor on the terminal permanent/unknown pause section, not the first
  // pauseAutoForProviderError after the model-error branch — that would match
  // the intervening tool-schema pause and let the test pass even if the real
  // terminal pause were reordered ahead of the model-error branch.
  const terminalSectionIdx = src.search(/Permanent\s*\/\s*unknown/i);
  assert.ok(terminalSectionIdx > 0, "terminal permanent/unknown pause section must exist");
  const terminalPauseIdx = src.indexOf("pauseAutoForProviderError", terminalSectionIdx);
  assert.ok(
    terminalPauseIdx > 0,
    "terminal provider-error pause must exist in the permanent/unknown section",
  );
  assert.ok(
    rejectionCallIdx < terminalPauseIdx,
    "model-error fallback branch must precede the terminal provider-error pause (#1533)",
  );
  const branch = src.slice(modelErrorIdx, rejectionCallIdx + 2000);
  assert.ok(
    branch.includes("shouldBlockModel: false"),
    "model-error fallback must not persistently block the model (#1533)",
  );
});

test("#1973: permanent/unknown provider-error pause aborts the still-live host turn", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-unknown-pause-abort-"));
  let abortCalls = 0;

  try {
    resetTransientRetryState();
    autoSession.reset();
    mkdirSync(join(base, ".gsd"), { recursive: true });
    process.chdir(base);

    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

    const ctx = {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      modelRegistry: { getAvailable: () => [] },
      isIdle: () => false,
      abort: () => {
        abortCalls += 1;
      },
      ui: {
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        setWorkingMessage: () => {},
      },
    } as any;
    const pi = {
      setModel: async () => false,
      sendMessage: () => {},
    } as any;

    await handleAgentEnd(pi, {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider exploded in a completely novel way",
      }],
    } as any, ctx);

    assert.equal(
      abortCalls,
      1,
      "permanent/unknown pause must abort the live host turn so a surviving session cannot keep executing against a torn-down Attempt",
    );
    assert.equal(autoSession.active, false, "auto-mode must be paused");
    assert.equal(autoSession.paused, true, "pause must be recorded");
  } finally {
    _resetPendingResolve();
    autoSession.reset();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("permanent/unknown provider-error pause message has a single colon (#2227)", async (t) => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-unknown-pause-colon-"));
  let abortCalls = 0;
  t.after(() => {
    _resetPendingResolve();
    autoSession.reset();
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  resetTransientRetryState();
  autoSession.reset();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  process.chdir(base);

  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
  const resultPromise = new Promise<any>((resolve) => _setCurrentResolve(resolve));

  const ctx = {
    model: { provider: "anthropic", id: "claude-opus-4" },
    modelRegistry: { getAvailable: () => [] },
    isIdle: () => false,
    abort: () => {
      abortCalls += 1;
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingMessage: () => {},
    },
  } as any;
  const pi = {
    setModel: async () => false,
    sendMessage: () => {},
  } as any;

  await handleAgentEnd(pi, {
    messages: [{
      role: "assistant",
      stopReason: "error",
      errorMessage: "Anthropic stream ended before message_stop",
    }],
  } as any, ctx);

  const result = await resultPromise;
  assert.equal(abortCalls, 1, "permanent/unknown pause must abort the live host turn");
  assert.deepEqual(result, {
    status: "cancelled",
    errorContext: {
      message: "Provider error: Anthropic stream ended before message_stop",
      category: "provider",
      isTransient: false,
    },
  });
});
