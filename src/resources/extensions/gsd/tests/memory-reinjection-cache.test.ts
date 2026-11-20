// Project/App: gsd-pi
// File Purpose: Content-addressed memory reinjection + superseded-injection
// payload policy regression tests (KV prefix-cache stability).

import test from "node:test";
import assert from "node:assert/strict";

import {
  memoryBlockContentHash,
  resetMemoryReinjectionState,
  shouldSkipMemoryReinjection,
} from "../bootstrap/system-context.ts";
import { applyProviderPayloadPolicy } from "../provider-payload-policy.js";
import { GSD_CONTEXT_MESSAGE_SENTINEL } from "../constants.js";
import type { ProviderPayloadPolicyDeps } from "../provider-payload-policy.js";
import type { ContextManagementConfig } from "../preferences-types.js";

function policyDeps(context?: ContextManagementConfig): ProviderPayloadPolicyDeps {
  return {
    isAutoActive: () => false,
    loadContextManagementConfig: () => context,
    renderSourceContextBlock: () => null,
    getEffectiveServiceTier: () => undefined,
    supportsServiceTier: () => false,
  };
}

test("content-addressed reinjection skips an identical block for the same session", () => {
  resetMemoryReinjectionState();
  const blockA = "[MEMORY — a]\n- same gotcha\n";
  const hashA = memoryBlockContentHash(blockA);

  assert.equal(shouldSkipMemoryReinjection("s1", hashA), false, "first injection must inject");
  assert.equal(shouldSkipMemoryReinjection("s1", hashA), true, "identical block must skip");

  const hashB = memoryBlockContentHash("[MEMORY — a]\n- changed gotcha\n");
  assert.notEqual(hashB, hashA);
  assert.equal(shouldSkipMemoryReinjection("s1", hashB), false, "changed block must inject");

  resetMemoryReinjectionState();
  assert.equal(shouldSkipMemoryReinjection("s2", hashA), false, "a new session never skips");
});

test("memoryBlockContentHash is whitespace-stable", () => {
  assert.equal(memoryBlockContentHash("  a\nb \n"), memoryBlockContentHash("a\nb"));
});

test("default policy keeps superseded injections (byte-stable prefix)", () => {
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: `${GSD_CONTEXT_MESSAGE_SENTINEL}\nfirst injection` }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: `${GSD_CONTEXT_MESSAGE_SENTINEL}\nsecond injection` }] },
    ],
  };
  applyProviderPayloadPolicy({ payload, deps: policyDeps(undefined) });
  assert.equal(payload.messages.length, 3, "keep must preserve every injection");
});

test("superseded_injections: drop restores the legacy filter", () => {
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: `${GSD_CONTEXT_MESSAGE_SENTINEL}\nfirst injection` }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: `${GSD_CONTEXT_MESSAGE_SENTINEL}\nsecond injection` }] },
    ],
  };
  applyProviderPayloadPolicy({ payload, deps: policyDeps({ superseded_injections: "drop" }) });
  assert.equal(payload.messages.length, 2, "drop must remove the superseded injection");
  assert.ok(String((payload.messages[1] as { content: { text: string }[] }).content[0].text).includes("second injection"));
});
