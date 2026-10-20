import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnboardingService } from "../web/onboarding-service.ts";

for (const [provider, endpoint] of [
  ["minimax", "https://api.minimax.io/anthropic/v1/messages"],
  ["minimax-cn", "https://api.minimaxi.com/anthropic/v1/messages"],
]) {
  test(`${provider} onboarding probes Flash using its adaptive request contract`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-minimax-onboarding-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const service = new OnboardingService({
      env: {},
      authPath: join(dir, "auth.json"),
      getEnvApiKey: () => undefined,
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const state = await service.validateAndSaveApiKey(provider, "test-key");
    assert.equal(state.lastValidation?.status, "succeeded");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, endpoint);
    assert.equal(requests[0].body.model, "MiniMax-M3.1-Flash");
    assert.deepEqual(requests[0].body.thinking, { type: "adaptive" });
    assert.deepEqual(requests[0].body.output_config, { effort: "max" });
  });
}
