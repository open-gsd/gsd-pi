/**
 * Dynamic routing start banner — pure message composition.
 *
 * startAutoMode shows the banner before the first dispatch so users know
 * upfront whether models will be downgraded (#3962). Extracted from
 * auto-start.ts to keep the composition unit-testable: parallel workers can
 * reach startAutoMode while the session model is still the unknown/unknown
 * placeholder (provider registration in flight), and the banner must never
 * present the placeholder as the model to be used.
 */

/** Model-like shape carried by the banner sources (snapshot or live model). */
export interface BannerModelLike {
  provider: string;
  id: string;
  api?: string;
}

/** Message shown when the session model is the startup placeholder. */
const UNRESOLVED_SUFFIX =
  "session model unresolved (providers may still be registering; " +
  "the first dispatch may pause if registration does not complete)";

/**
 * True when the model is pi-agent-core's startup placeholder
 * (`DEFAULT_MODEL`, packages/pi-agent-core/src/agent.ts). Uses the same
 * provider/api predicate as `repairPlaceholderModel`
 * (agent-session-model.ts); snapshot pairs carry no api field, so id is
 * accepted as the fallback discriminator.
 */
export function isPlaceholderSessionModel(model: BannerModelLike | undefined | null): boolean {
  if (!model) return false;
  return model.provider === "unknown" && (model.api ?? model.id) === "unknown";
}

/**
 * Compose the dynamic routing start banner.
 *
 * - `startModel` is the auto-mode start-model snapshot (`s.autoModeStartModel`),
 *   `sessionModel` the live session model (`ctx.model`); the snapshot wins.
 * - `heavyTierModel` is `dynamic_routing.tier_models.heavy` — the ceiling when
 *   routing is effectively enabled.
 * - An unresolved model is reported as such, never as `unknown/unknown`.
 */
export function formatDynamicRoutingBanner(opts: {
  effectivelyEnabled: boolean;
  startModel: { provider: string; id: string } | null;
  sessionModel: BannerModelLike | undefined | null;
  heavyTierModel?: string;
}): string {
  const { effectivelyEnabled, startModel, sessionModel, heavyTierModel } = opts;

  const resolved =
    [startModel, sessionModel].find((m) => m && !isPlaceholderSessionModel(m)) ?? null;
  const label = resolved
    ? `${resolved.provider}/${resolved.id}`
    : startModel || sessionModel
    ? "unresolved"
    : "default";

  if (effectivelyEnabled) {
    const ceiling = heavyTierModel ?? label;
    return `Dynamic routing: enabled — simple tasks may use cheaper models (ceiling: ${ceiling})`;
  }
  if (label === "unresolved") {
    return `Dynamic routing: disabled — ${UNRESOLVED_SUFFIX}`;
  }
  return `Dynamic routing: disabled — all tasks will use ${label}`;
}