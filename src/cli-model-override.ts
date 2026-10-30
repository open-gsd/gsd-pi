import { getModelRequestPolicy } from '@gsd/pi-ai/model-request-policy.js'
import type { ModelRegistry as ModelRegistryInstance } from '@gsd/pi-coding-agent'

/**
 * Apply the --model CLI flag override to the active session.
 * Searches available models by exact id or provider/id pattern and warns
 * on stderr when the requested model is not found in the registry.
 *
 * The setModel call is intentionally fire-and-forget: provider readiness
 * checks run later in startup so --model does not block session creation.
 */
export function applyModelOverride(
  session: { setModel(model: { provider: string; id: string }): unknown | Promise<unknown> },
  modelRegistry: ModelRegistryInstance,
  modelFlag: string | undefined,
): void {
  if (!modelFlag) return
  const available = modelRegistry.getAvailable()
  const match =
    available.find((m) => m.id === modelFlag) ||
    available.find((m) => `${m.provider}/${m.id}` === modelFlag)
  if (match) {
    void session.setModel(match)
  } else {
    if (getModelRequestPolicy() !== undefined) {
      throw new Error(`Model override "${modelFlag}" is unavailable under GSD_MODEL_ALLOWLIST; refusing fallback`)
    }
    process.stderr.write(`[gsd] Warning: Model "${modelFlag}" not found. Using configured default.\n`)
  }
}
