import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { resolvePath } from "@gsd/pi-coding-agent/utils/paths.js";
import { parseSkillBlock } from "./agent-session.ts";
import { AgentSessionExtensionsModule } from "./session/agent-session-extensions.ts";
import { AgentSessionEventsModule } from "./session/agent-session-events.ts";
import { AgentSessionModelModule } from "./session/agent-session-model.ts";
import { AgentSessionNavigationModule } from "./session/agent-session-navigation.ts";
import { AgentSessionPromptModule } from "./session/agent-session-prompt.ts";

describe("parseSkillBlock", () => {
  test("parses a valid skill block with trailing user message", () => {
    const text = `<skill name="review" location=".gsd/skills/review.md">
Follow the checklist.
</skill>

Please review the patch.`;

    const parsed = parseSkillBlock(text);
    assert.ok(parsed);
    assert.equal(parsed.name, "review");
    assert.equal(parsed.location, ".gsd/skills/review.md");
    assert.match(parsed.content, /checklist/);
    assert.equal(parsed.userMessage, "Please review the patch.");
  });

  test("returns null for malformed skill blocks", () => {
    assert.equal(parseSkillBlock("not a skill"), null);
    assert.equal(parseSkillBlock('<skill name="x" location="y">missing close'), null);
  });
});

describe("AgentSessionExtensionsModule", () => {
  test("bindExtensions forwards extension UI context into provider stream options", async () => {
    const uiContext = { notify: () => {} };
    let received: Record<string, unknown> | undefined;
    const host = {
      _extensionUIContext: undefined as typeof uiContext | undefined,
      _extensionRunner: {
        setUIContext: () => {},
        bindCommandContext: () => {},
        onError: () => () => {},
        emit: async () => {},
        hasHandlers: () => false,
      },
      _sessionStartEvent: { type: "session_start", reason: "startup" },
      agent: {
        streamFn: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
          received = options;
          return { type: "stream" } as any;
        },
      },
    };

    const mod = new AgentSessionExtensionsModule(host as any);
    await mod.bindExtensions({ uiContext: uiContext as any });

    host.agent.streamFn({}, {}, { maxTokens: 1 });
    assert.equal(received?.extensionUIContext, uiContext);
  });

  test("skills are no longer embedded in the system prompt (discovered on-demand)", () => {
    const host = {
      _cwd: "/tmp/project",
      _toolRegistry: new Map([["read", {}]]),
      _toolPromptSnippets: new Map(),
      _toolPromptGuidelines: new Map(),
      _visibleSkillNames: ["review-skill"],
      resourceLoader: {
        getSystemPrompt: () => undefined,
        getAppendSystemPrompt: () => [],
        getSkills: () => ({
          skills: [
            makeSkill("Review-Skill"),
            makeSkill("other-skill"),
          ],
        }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      },
    };

    const prompt = new AgentSessionExtensionsModule(host as any).rebuildSystemPrompt(["read"]);

    // Skills are discovered on-demand via the read tool — no longer embedded
    // in the system prompt (~29KB saved per request).
    assert.doesNotMatch(prompt, /<name>Review-Skill<\/name>/);
    assert.doesNotMatch(prompt, /<name>other-skill<\/name>/);
    assert.doesNotMatch(prompt, /<available_skills>/);
  });

  test("forwards setModel persistence options to the session", async () => {
    const model = { provider: "test-provider", id: "test-model" };
    let receivedOptions: { persist?: boolean } | undefined;
    let boundSetModel:
      | ((selectedModel: typeof model, options?: { persist?: boolean }) => Promise<boolean>)
      | undefined;
    const host = {
      modelRegistry: { hasConfiguredAuth: () => true },
      setModel: async (_selectedModel: typeof model, options?: { persist?: boolean }) => {
        receivedOptions = options;
      },
      promptTemplates: [],
      resourceLoader: { getSkills: () => ({ skills: [] }) },
    };
    const runner = {
      bindCore: (actions: { setModel: typeof boundSetModel }) => {
        boundSetModel = actions.setModel;
      },
    };

    new AgentSessionExtensionsModule(host as any).bindExtensionCore(runner as any);
    assert.ok(boundSetModel);
    assert.equal(await boundSetModel(model, { persist: false }), true);
    assert.deepEqual(receivedOptions, { persist: false });
  });
});

describe("AgentSessionModelModule", () => {
  test("switches models without changing the default when persist is false", async () => {
    const { host, model, persistedModels, sessionModels } = makeModelModuleHost();

    await new AgentSessionModelModule(host as any).setModel(model as any, { persist: false });

    assert.equal(host.agent.state.model, model);
    assert.deepEqual(sessionModels, [[model.provider, model.id]]);
    assert.deepEqual(persistedModels, []);
  });

  test("persists the default model when persistence options are omitted", async () => {
    const { host, model, persistedModels } = makeModelModuleHost();

    await new AgentSessionModelModule(host as any).setModel(model as any);

    assert.deepEqual(persistedModels, [[model.provider, model.id]]);
  });
});

describe("AgentSessionNavigationModule", () => {
  test("session-transition teardown aborts with the programmatic origin", async () => {
    // #2218: the origin lets downstream classification tell an internal
    // transition teardown apart from a user cancellation.
    const aborts: Array<string | undefined> = [];
    const host = {
      agent: {
        state: { isStreaming: true },
        waitForIdle: async () => {},
      },
      abortRetry: () => {},
      abort: async (origin?: string) => {
        aborts.push(origin);
      },
    };

    await new AgentSessionNavigationModule(host as any).settleCurrentTurnForSessionTransition();

    assert.deepEqual(aborts, ["programmatic"]);
  });

  test("records workspaceRoot as the new session header cwd", async () => {
    // Canonicalize with the same resolver the session code uses so the
    // expected cwd matches on Windows too (a bare POSIX path like
    // "/tmp/..." resolves to "C:\\tmp\\..." there). No-op on POSIX.
    const projectRoot = resolvePath("/tmp/project-root");
    const worktreeRoot = resolvePath("/tmp/project-root/.gsd-worktrees/M001");
    const sessionManager = SessionManager.inMemory(projectRoot);
    let rebuiltRuntime = false;

    const host = {
      sessionFile: undefined,
      _extensionRunner: undefined,
      _cwd: projectRoot,
      _steeringMessages: ["old"],
      _followUpMessages: ["old"],
      _pendingNextTurnMessages: ["old"],
      thinkingLevel: "off",
      agent: {
        state: { isStreaming: false },
        sessionId: sessionManager.getSessionId(),
        waitForIdle: async () => {},
        reset: () => {},
      },
      sessionManager,
      abortRetry: () => {},
      abort: async () => {},
      disconnectFromAgent: () => {},
      reconnectToAgent: () => {},
      getActiveToolNames: () => [],
      buildRuntime: () => {
        rebuiltRuntime = true;
      },
      refreshToolRegistry: () => {},
      emitSessionStartWithLegacySwitch: async () => {},
    };

    const result = await new AgentSessionNavigationModule(host as any).newSession({
      workspaceRoot: worktreeRoot,
    });

    assert.equal(result, true);
    assert.equal(host._cwd, worktreeRoot);
    assert.equal(sessionManager.getHeader()?.cwd, worktreeRoot);
    assert.equal(sessionManager.getCwd(), worktreeRoot);
    assert.equal(rebuiltRuntime, true);
  });
});

describe("AgentSessionEventsModule", () => {
  test("forwards abortOrigin on the extension agent_end event", async () => {
    // #2218: a timeout kill must reach extension handlers with its origin.
    const emitted: Array<Record<string, unknown>> = [];
    const host = {
      _extensionRunner: {
        emit: async (event: Record<string, unknown>) => {
          emitted.push(event);
        },
      },
    };

    await new AgentSessionEventsModule(host as any).emitExtensionEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
      abortOrigin: "timeout",
    } as any, false);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, "agent_end");
    assert.equal(emitted[0]?.abortOrigin, "timeout");
    assert.equal(emitted[0]?.willRetry, false);
  });

  test("omits abortOrigin when the run ends normally", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const host = {
      _extensionRunner: {
        emit: async (event: Record<string, unknown>) => {
          emitted.push(event);
        },
      },
    };

    await new AgentSessionEventsModule(host as any).emitExtensionEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    } as any, false);

    assert.equal(emitted.length, 1);
    assert.equal("abortOrigin" in emitted[0], false);
  });
});

describe("AgentSessionPromptModule", () => {
  test("keeps no-progress terminal fingerprint across other retryable errors", async () => {
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "do the work" }],
      timestamp: 1,
    };
    const events: Array<{ type: string }> = [];
    const host = {
      _retryAttempt: 0,
      _retryAbortController: undefined,
      settingsManager: {
        getRetrySettings: () => ({
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 0,
        }),
      },
      emit: (event: { type: string }) => {
        events.push(event);
      },
      agent: {
        state: {
          messages: [] as any[],
        },
      },
    };
    const mod = new AgentSessionPromptModule(host as any);

    const firstTerminalFailure = makeAssistantError("terminated before any output");
    host.agent.state.messages = [userMessage, firstTerminalFailure];
    assert.equal(await mod.prepareRetry(firstTerminalFailure as any), true);

    const unrelatedRetryableFailure = makeAssistantError("overloaded_error: provider is busy");
    host.agent.state.messages = [userMessage, unrelatedRetryableFailure];
    assert.equal(await mod.prepareRetry(unrelatedRetryableFailure as any), true);

    const repeatedTerminalFailure = makeAssistantError("terminated before any output");
    host.agent.state.messages = [userMessage, repeatedTerminalFailure];
    assert.equal(mod.canPrepareRetry(repeatedTerminalFailure as any), false);
    assert.equal(await mod.prepareRetry(repeatedTerminalFailure as any), false);
    assert.equal(host._retryAttempt, 2);
    assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 2);
  });
});

function makeSkill(name: string) {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { kind: "test" },
    source: "test",
    disableModelInvocation: false,
  };
}

function makeModelModuleHost() {
  const model = { provider: "test-provider", id: "test-model", reasoning: false };
  const persistedModels: string[][] = [];
  const sessionModels: string[][] = [];
  const host = {
    model: undefined,
    thinkingLevel: "off",
    agent: { state: { model: undefined, thinkingLevel: "off" } },
    modelRegistry: { hasConfiguredAuth: () => true },
    sessionManager: {
      appendModelChange: (provider: string, id: string) => sessionModels.push([provider, id]),
    },
    settingsManager: {
      getDefaultThinkingLevel: () => "off",
      setDefaultModelAndProvider: (provider: string, id: string) => persistedModels.push([provider, id]),
    },
    setThinkingLevel: () => {},
    _extensionRunner: { emit: async () => {} },
  };

  return { host, model, persistedModels, sessionModels };
}

function makeAssistantError(errorMessage: string) {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 1,
  };
}
