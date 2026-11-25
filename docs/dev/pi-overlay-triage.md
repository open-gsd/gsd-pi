# Pi overlay triage

Disposition for every file in the overlay set (`scripts/pi-upstream.json` `patchAllowlist`, after the path corrections, plus `scripts/pi-seam.json` `protectedPiCoreFiles`).
This table does not delete or move any file. A follow-on plan uses it to decide what can become an npm facade.

`blocks leaf facade` is `yes` when the file changes `pi-ai`, `pi-tui`, or `pi-agent-core` behavior that a re-export of the published package would lose.

| path | purpose | disposition | blocks leaf facade |
| --- | --- | --- | --- |
| `packages/pi-agent-core/src/agent.ts` | Threads cacheRetention into the agent loop | keep-overlay | yes |
| `packages/pi-agent-core/test/agent.test.ts` | Regression test for an overlay delta | keep-overlay | no |
| `packages/pi-ai/src/models/fake-model.ts` | Local fake model used by provider tests | keep-overlay | yes |
| `packages/pi-ai/src/providers/anthropic.ts` | Drops a wasted OAuth cache breakpoint | keep-overlay | yes |
| `packages/pi-ai/src/providers/fake.ts` | Provider behavior that a published pi-ai re-export would drop | keep-overlay | yes |
| `packages/pi-ai/src/providers/google-shared.ts` | Claude tool schema sanitization for Cloud Code Assist | keep-overlay | yes |
| `packages/pi-ai/src/providers/mistral.ts` | Provider behavior that a published pi-ai re-export would drop | keep-overlay | yes |
| `packages/pi-ai/src/providers/provider-capabilities.ts` | Provider behavior that a published pi-ai re-export would drop | keep-overlay | yes |
| `packages/pi-ai/src/utils/tests/normalize-tool-arguments.test.ts` | Regression test for an overlay delta | keep-overlay | no |
| `packages/pi-ai/test/cache-retention.test.ts` | Regression test for an overlay delta | keep-overlay | no |
| `packages/pi-ai/test/google-shared-convert-tools.test.ts` | Regression test for an overlay delta | keep-overlay | no |
| `packages/pi-coding-agent/scripts/copy-assets.cjs` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/artifact-manager.ts` | Re-export of @gsd/agent-core kept on the coding-agent path for extensions | move-to-host | no |
| `packages/pi-coding-agent/src/core/blob-store.ts` | Re-export of @gsd/agent-core kept on the coding-agent path for extensions | move-to-host | no |
| `packages/pi-coding-agent/src/core/capability-patches.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/constants.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/db-snapshot.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/discovery-cache.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/extension-session-types.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/extensions/loader.ts` | Extension loader aliases for @gsd and legacy pi package names | keep-overlay | no |
| `packages/pi-coding-agent/src/core/extensions/types.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/fallback-resolver.ts` | Re-export of @gsd/agent-core kept on the coding-agent path for extensions | move-to-host | no |
| `packages/pi-coding-agent/src/core/gsd-extension-types.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/gsd-seam-types.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/keybindings.ts` | Re-export of @gsd/agent-core kept on the coding-agent path for extensions | move-to-host | no |
| `packages/pi-coding-agent/src/core/lifecycle-hooks.ts` | Re-export of @gsd/agent-core kept on the coding-agent path for extensions | move-to-host | no |
| `packages/pi-coding-agent/src/core/local-model-check.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/model-discovery.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/model-registry.ts` | Model discovery and GSD auth modes | keep-overlay | no |
| `packages/pi-coding-agent/src/core/models-json-writer.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/package-commands.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/session-cwd.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/settings-manager.ts` | GSD settings shims including adaptive TUI and cacheRetention | keep-overlay | no |
| `packages/pi-coding-agent/src/core/system-prompt.ts` | Re-export of @gsd/agent-core kept on the coding-agent path for extensions | move-to-host | no |
| `packages/pi-coding-agent/src/core/tools/bash-interceptor.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/core/tools/tool-compatibility-registry.ts` | GSD delta that must be reapplied after generation | keep-overlay | no |
| `packages/pi-coding-agent/src/theme/theme-highlight.test.ts` | Regression test for an overlay delta | keep-overlay | no |
| `packages/pi-coding-agent/src/theme/theme-schema.ts` | Shared theme assets, including the native highlight import | keep-overlay | no |
| `packages/pi-coding-agent/src/theme/theme.ts` | Shared theme assets, including the native highlight import | keep-overlay | no |
| `packages/pi-coding-agent/src/theme/themes.ts` | Shared theme assets, including the native highlight import | keep-overlay | no |
| `packages/pi-coding-agent/test/settings-manager.test.ts` | Regression test for an overlay delta | keep-overlay | no |
| `packages/pi-tui/src/editor-keybindings.ts` | Editor keybinding compat used by interactive mode | keep-overlay | yes |
| `packages/pi-tui/src/style.ts` | GSD terminal style primitives, including native truncation | keep-overlay | yes |
