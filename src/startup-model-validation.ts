/**
 * Startup model validation — extracted from cli.ts so it can be called
 * AFTER extensions register their models in the ModelRegistry.
 *
 * Before this extraction (bug #2626), the validation ran before
 * createAgentSession(), meaning extension-provided models (e.g.
 * claude-code/claude-sonnet-4-6) were not yet in the registry.
 * configuredExists was always false for extension models, causing the
 * user's valid choice to be silently overwritten with a built-in fallback.
 */

import { getPiDefaultModelAndProvider } from './pi-migration.js'

interface MinimalModel {
  provider: string
  id: string
}

interface MinimalModelRegistry {
  getAvailable(): MinimalModel[]
  getAll?(): MinimalModel[]
  isProviderRequestReady?(provider: string): boolean
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface MinimalSettingsManager {
  getDefaultProvider(): string | undefined
  getDefaultModel(): string | undefined
  getDefaultThinkingLevel(): ThinkingLevel | undefined
  setDefaultModelAndProvider(provider: string, modelId: string): void
  setDefaultThinkingLevel(level: ThinkingLevel): void
}

/**
 * Outcome of validating the configured default model.
 * `action` reports whether the persisted default was rewritten:
 *   - "preserved": the configured model (if any) was left untouched.
 *   - "fell-back": the configured model was unavailable and settings were
 *     rewritten to a fallback. `from`/`to` carry the previous and new
 *     `provider/id` defaults (null when unset).
 */
export interface ModelValidationResult {
	action: 'preserved' | 'fell-back'
	from: string | null
	to: string | null
}

/**
 * Validate the configured default model against the registry.
 *
 * If the configured model exists in the registry, this is a no-op — the
 * user's choice is preserved.  If it does not exist (stale settings from a
 * prior install, or genuinely removed model), a fallback is selected and
 * written to settings.
 *
 * Returns a {@link ModelValidationResult} so callers can notify the user
 * when the persisted default was rewritten (#2077 — the rewrite used to be
 * silent and one-way).
 *
 * IMPORTANT: Call this AFTER createAgentSession() so that extension-
 * provided models have been registered in the ModelRegistry.
 */
export function validateConfiguredModel(
	modelRegistry: MinimalModelRegistry,
	settingsManager: MinimalSettingsManager,
): ModelValidationResult {
  const configuredProvider = settingsManager.getDefaultProvider()
  const configuredModel = settingsManager.getDefaultModel()
  const from = configuredProvider && configuredModel
    ? `${configuredProvider}/${configuredModel}`
    : null
  const preserved: ModelValidationResult = { action: 'preserved', from: null, to: null }
  const availableModels = modelRegistry.getAvailable()
  const catalogModels = modelRegistry.getAll?.() ?? availableModels
  // Check against availableModels (configured + auth'd) rather than getAll()
  // so a stale default pointing at an unconfigured provider triggers the
  // fallback. Previously a model present in the registry but missing API
  // key / OAuth would satisfy configuredExists and survive startup, ending
  // up as ctx.model even though it couldn't actually be used.
  const configuredExists = configuredProvider && configuredModel &&
    availableModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)
  const configuredInCatalog = configuredProvider && configuredModel &&
    catalogModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)

  // Preserve explicit settings when the model is still in the catalog but
  // temporarily absent from getAvailable() (#2077). Only rewrite when the
  // model is genuinely gone, or the provider is known to be unready.
  if (configuredInCatalog && !configuredExists) {
    const providerReady = configuredProvider
      ? modelRegistry.isProviderRequestReady?.(configuredProvider)
      : undefined
    if (providerReady !== false) {
      return preserved
    }
  }

  let result = preserved
  if (!configuredModel || !configuredExists) {
    // Model not configured at all, or removed from registry — pick a fallback.
    // Only fires when the model is genuinely unknown (not just temporarily unavailable).
    //
    // Model-agnostic selection order:
    //   1. Pi migration default (preserves migration from ~/.pi install)
    //   2. Any model from the user's previously-chosen provider (provider stickiness)
    //   3. First available model in registry order (user-controlled via models.json)
    const piDefault = getPiDefaultModelAndProvider()
    const preferred =
      (piDefault
        ? availableModels.find((m) => m.provider === piDefault.provider && m.id === piDefault.model)
        : undefined) ||
      (configuredProvider
        ? availableModels.find((m) => m.provider === configuredProvider)
        : undefined) ||
      availableModels[0]
    if (preferred) {
      settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id)
      result = {
        action: 'fell-back',
        from,
        to: `${preferred.provider}/${preferred.id}`,
      }
    }
  }

  if (settingsManager.getDefaultThinkingLevel() !== 'off' && !configuredExists) {
    settingsManager.setDefaultThinkingLevel('off')
  }
  return result
}

/**
 * Format the user-facing warning for a fell-back validation result.
 * Returns null when nothing needs to be said: preserved results, rewrites
 * where nothing was previously configured (initial setup, not a downgrade),
 * and rewrites with no available fallback (settings untouched).
 */
export function formatModelFallbackNotice(result: ModelValidationResult): string | null {
  if (result.action !== 'fell-back' || !result.from || !result.to) return null
  return (
    `[gsd] Warning: configured default model ${result.from} is not available; ` +
    `the saved default was rewritten to ${result.to}. ` +
    `Restore ${result.from} with /model once it is available again.`
  )
}
