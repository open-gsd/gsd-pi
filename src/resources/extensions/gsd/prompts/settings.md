You are running the GSD **settings** workflow — configure GSD workflow toggles and the model profile.

## Effective configuration (authoritative)

The current effective configuration is embedded below. Use this block as the source of truth — do not search for or read package docs under `pkg/README.md`, `pkg/docs`, or `pkg/examples` (those paths are not shipped in the published npm package).

```
{{effectiveConfig}}
```

For preference field documentation, read `{{preferencesReferencePath}}` only when you need to explain a specific key.

## Process

This is the settings flow: present the current effective configuration and let the developer change it.

1. **Show effective settings.** Display the embedded configuration above: active provider/model, model profile, auto-mode toggles, commit granularity, review depth, isolation mode, language, and any feature flags.

2. **Offer changes**, grouped:
   - **LLM**: provider, model, default tier — `/gsd setup llm` / `/gsd model`.
   - **Workflow**: auto-mode behavior, isolation mode, commit granularity — `/gsd prefs`.
   - **Keys**: API keys — `/gsd keys`.
   - **Integrations**: remote, search, cmux — `/gsd setup remote|search`, `/gsd cmux`.
   - **Onboarding**: re-run the wizard — `/gsd onboarding`.

3. **Apply the selection** by routing to the matching gsd-pi command. Confirm before changing anything destructive (e.g. switching provider, wiping keys).

4. **Re-show** the effective settings after changes.

## Success criteria

- The displayed settings reflect the real config overlay.
- Every change routes to the real gsd-pi command, keeping state canonical.
- Destructive changes are confirmed.
