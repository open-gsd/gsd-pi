/**
 * Regression test for #4548 — Bug 2: Provider Manager routes Enter into the
 * OAuth login dialog for ALL providers, including externalCli providers like
 * claude-code. This produces:
 *
 *   "Failed to login to claude-code: Unknown OAuth provider: claude-code"
 *
 * The fix routes selected providers through the shared /login auth dispatcher:
 * externalCli providers are activated and selected instead of being sent to
 * the OAuth dialog.
 *
 * This test verifies the guard through the provider manager callback behavior.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { initTheme } from "../../packages/pi-coding-agent/src/theme/theme.ts";

const { InteractiveMode } = await import("../../packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts");
const { buildLoginProviderOptions } = await import("../../packages/gsd-agent-modes/src/modes/interactive/interactive-selectors-auth.ts");

initTheme("dark", false);

function createProviderManagerHarness(oauthProviderIds: string[]) {
  const statusMessages: string[] = [];
  const loginProviders: string[] = [];
  const storedAuth: Array<{ provider: string; value: unknown }> = [];
  const setModels: Array<{ provider: string; id: string }> = [];
  let doneCount = 0;
  let component: any;
  // External-CLI readiness is cached: the CLI only reads as ready once the
  // activation flow has awaited a fresh probe.
  const settledProviders = new Set<string>();
  const authStorage = {
    getOAuthProviders: () => oauthProviderIds.map((id) => ({ id })),
    hasAuth: () => false,
    set: (provider: string, value: unknown) => {
      storedAuth.push({ provider, value });
    },
  };
  const mode = Object.create(InteractiveMode.prototype) as any;
  mode.ui = { requestRender() {} };
  const models = [
    { provider: "claude-code", id: "claude-sonnet-4-6", name: "Claude Code", api: "anthropic-messages" },
    { provider: "openai-codex", id: "gpt-test", name: "GPT Test", api: "openai" },
  ];
  mode.session = {
    modelRegistry: {
      authStorage,
      modelsJsonPath: "/tmp/models.json",
      getAll: () => models,
      getAvailable: () => models,
      getProviderAuthMode: (provider: string) => provider === "claude-code" ? "externalCli" : "oauth",
      getProviderDisplayName: (provider: string) => provider === "claude-code" ? "Claude Code CLI" : provider,
      settleProviderReadiness: async (provider?: string) => {
        if (provider) settledProviders.add(provider);
      },
      isProviderRequestReady: (provider: string) => provider === "claude-code" && settledProviders.has(provider),
      refresh() {},
      discoverModels: async () => [],
    },
    setModel: async (model: { provider: string; id: string }) => {
      setModels.push(model);
    },
  };
  mode.updateAvailableProviderCount = async () => {};
  mode.showStatus = (message: string) => {
    statusMessages.push(message);
  };
  mode.showLoginDialog = async (provider: string) => {
    loginProviders.push(provider);
  };
  mode.showSelector = (factory: (done: () => void) => { component: unknown }) => {
    const result = factory(() => {
      doneCount += 1;
    });
    component = result.component;
  };

  mode.showProviderManager();
  return { component, statusMessages, loginProviders, storedAuth, setModels, get doneCount() { return doneCount; } };
}

describe("interactive-mode.ts — provider Enter-key routing guard (#4548)", () => {
  test("/login offers Claude Code CLI and Anthropic API key, not Anthropic browser OAuth", () => {
    const host = {
      session: {
        modelRegistry: {
          authStorage: {
            getOAuthProviders: () => [
              { id: "anthropic", name: "Anthropic OAuth" },
              { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex)" },
            ],
          },
	          getAll: () => [
	            { provider: "anthropic", id: "claude-sonnet-4-6" },
	            { provider: "claude-code", id: "claude-sonnet-4-6" },
	            { provider: "google-gemini-cli", id: "gemini-2.5-flash" },
	            { provider: "google-antigravity", id: "default" },
	            { provider: "openai-codex", id: "gpt-test" },
	          ],
	          getProviderAuthMode: (provider: string) => ["claude-code", "google-gemini-cli", "google-antigravity"].includes(provider)
	            ? "externalCli"
	            : provider === "openai-codex"
	              ? "oauth"
	              : "apiKey",
          getProviderDisplayName: (provider: string) => provider === "anthropic"
            ? "Anthropic"
	            : provider === "claude-code"
	              ? "Claude Code CLI"
	              : provider === "google-gemini-cli"
	                ? "Google Gemini CLI"
	                : provider === "google-antigravity"
	                  ? "Google Antigravity"
	                  : provider,
	          isProviderRequestReady: (provider: string) => provider === "claude-code",
          getProviderAuthStatus: () => ({ configured: false }),
        },
      },
    };

    const options = buildLoginProviderOptions(host);
    const byIdAndType = options.map((option: any) => `${option.id}:${option.authType}`);

	    assert.ok(byIdAndType.includes("claude-code:external_cli"));
	    assert.ok(byIdAndType.includes("google-gemini-cli:external_cli"));
	    assert.ok(byIdAndType.includes("google-antigravity:external_cli"));
	    assert.ok(byIdAndType.includes("anthropic:api_key"));
    assert.ok(byIdAndType.includes("openai-codex:oauth"));
    assert.ok(!byIdAndType.includes("anthropic:oauth"));
  });

  test("externalCli providers activate and select the CLI provider instead of opening OAuth", async () => {
    const harness = createProviderManagerHarness(["openai-codex"]);

    await harness.component.onSetupAuth("claude-code");

    assert.equal(harness.doneCount, 1);
    assert.deepEqual(harness.loginProviders, []);
    assert.deepEqual(harness.storedAuth, [{ provider: "claude-code", value: { type: "api_key", key: "cli" } }]);
    assert.deepEqual(harness.setModels, [{ provider: "claude-code", id: "claude-sonnet-4-6", name: "Claude Code", api: "anthropic-messages" }]);
    assert.equal(harness.statusMessages.length, 1);
    assert.match(harness.statusMessages[0], /Using Claude Code CLI/i);
  });

  test("OAuth providers still route to showLoginDialog", async () => {
    const harness = createProviderManagerHarness(["openai-codex"]);

    await harness.component.onSetupAuth("openai-codex");

    assert.equal(harness.doneCount, 1);
    assert.deepEqual(harness.loginProviders, ["openai-codex"]);
    assert.deepEqual(harness.statusMessages, []);
  });
});
