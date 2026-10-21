/**
 * GSD Extension — Shared Constants
 *
 * Centralized timeout and cache-size constants used across the GSD extension.
 */

// ─── Timeouts ─────────────────────────────────────────────────────────────────

/** Default timeout for verification-gate commands (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// ─── Cache Sizes ──────────────────────────────────────────────────────────────

/** Max directory-listing cache entries before eviction (#611). */
export const DIR_CACHE_MAX = 200;

/** Max parse-cache entries before eviction. */
export const CACHE_MAX = 50;

// ─── Tool Scoping ─────────────────────────────────────────────────────────────

/**
 * GSD tools allowed during discuss flows (#2949).
 *
 * xAI/Grok (and potentially other providers with grammar-based constrained
 * decoding) return "Grammar is too complex" (HTTP 400) when the combined
 * tool schemas exceed their internal grammar limit. The full GSD tool set
 * registers ~33 tools with deeply nested schemas; discuss flows only need
 * a small subset.
 *
 * By scoping tools to this allowlist during discuss dispatches, the grammar
 * sent to the provider stays well under provider limits.
 *
 * Included tools and why (canonical names only — aliases are no longer
 * advertised to models by default, see plan 035):
 *   - gsd_summary_save: writes CONTEXT.md artifacts (all discuss prompts)
 *   - gsd_decision_save: records decisions (discuss.md output phase)
 *   - gsd_plan_milestone: writes roadmap (discuss.md single/multi milestone)
 *   - gsd_milestone_generate_id: generates milestone IDs (discuss.md multi-milestone)
 *   - gsd_requirement_save: creates requirements during discuss
 *   - gsd_requirement_update: updates requirements during discuss
 */
export const DISCUSS_TOOLS_ALLOWLIST: readonly string[] = [
  // Context / summary writing
  "gsd_summary_save",
  // Decision recording
  "gsd_decision_save",
  // Milestone planning (needed for discuss.md output phase)
  "gsd_plan_milestone",
  // Milestone ID generation (multi-milestone flow)
  "gsd_milestone_generate_id",
  // Requirement updates
  "gsd_requirement_save",
  "gsd_requirement_update",
];

// ─── Context Injection ────────────────────────────────────────────────────────

/**
 * Leading marker stamped on every buildContextMessage() output
 * (bootstrap/system-context.ts). Single source of truth for the producer and
 * the consumer: the provider payload policy (filterSupersededContextInjections
 * in context-masker.ts) matches this prefix to find and dedupe injected
 * memory/guided/forensics messages after convertToLlm strips their customType.
 * Both sides import it from here — do not inline the literal in either module.
 */
export const GSD_CONTEXT_MESSAGE_SENTINEL = "[GSD Context Injection]";
