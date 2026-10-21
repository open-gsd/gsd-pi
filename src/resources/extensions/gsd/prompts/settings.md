You are running the GSD **settings** workflow — configure GSD workflow toggles and the model profile.

## Process

This is the settings flow: present the current effective configuration and let the developer change it.

1. **Show effective settings.** Display the current configuration: active provider/model, model profile, auto-mode toggles, commit granularity, review depth, isolation mode, language, and any feature flags. Pull these from gsd-pi's config overlay, not memory.

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
