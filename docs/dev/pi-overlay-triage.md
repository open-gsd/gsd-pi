# Pi overlay triage

Disposition of every allowlisted overlay file after the v1.6.1 pin.

| path | disposition | purpose | blocks leaf facade |
| --- | --- | --- | --- |
| `packages/pi-agent-core/src/agent-loop.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-agent-core/src/agent.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-agent-core/src/types.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-agent-core/test/agent.test.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/api/anthropic-messages.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/api/claude-tool-schema.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/api/google-shared.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/models/fake-model.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/providers/fake.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/providers/provider-capabilities.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/src/utils/tests/normalize-tool-arguments.test.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/test/cache-retention.test.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-ai/test/google-shared-convert-tools.test.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/artifact-manager.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/blob-store.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/capability-patches.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/constants.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/db-snapshot.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/discovery-cache.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/extension-session-types.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/extensions/loader.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/extensions/types.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/fallback-resolver.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/gsd-extension-types.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/gsd-seam-types.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/keybindings.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/lifecycle-hooks.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/local-model-check.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/model-discovery.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/model-registry.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/models-json-writer.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/package-commands.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/session-cwd.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/settings-manager.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/settings-schema.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/system-prompt.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/tools/bash-interceptor.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/core/tools/tool-compatibility-registry.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/dark.json` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/light.json` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/system-theme.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/theme-controller.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/theme-schema.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/theme-tokens.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/src/theme/theme.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-coding-agent/test/settings-manager.test.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-tui/src/editor-keybindings.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
| `packages/pi-tui/src/style.ts` | keep-overlay | v1.6.1 pin port or GSD-only | no |
