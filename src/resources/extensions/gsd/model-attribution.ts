// Project/App: gsd-pi
// File Purpose: Per-message GSD dynamic-routing attribution (ADR-049, #2208).

import type { ModelRouting } from "@gsd/pi-ai";

/**
 * Shape shared with `AutoSession.currentUnitRouting`
 * (`{ tier: string; modelDowngraded: boolean }`). Read once at assistant
 * message_start and copied as values, so a unit transition while the message
 * is still streaming cannot relabel it.
 */
export interface UnitRoutingSnapshot {
  tier: string;
  modelDowngraded: boolean;
}

const VALID_TIERS: readonly string[] = ["light", "standard", "heavy"];

// Agent assistant lifecycles are serialized, so a single pending snapshot is
// sufficient. A WeakMap keyed by message identity is not safe: the streaming
// message_start object and the finalized message_end object are not guaranteed
// to be the same object.
let pendingRouting: UnitRoutingSnapshot | null = null;

/**
 * Capture the routing snapshot in effect when an assistant message starts.
 * Non-assistant messages never touch pending state; an assistant message that
 * starts without dynamic-routing state clears any stale snapshot.
 */
export function captureAssistantRoutingStart(
  message: { role?: unknown } | null | undefined,
  currentRouting: UnitRoutingSnapshot | null | undefined,
  autoActive: boolean,
): void {
  if (!message || message.role !== "assistant") return;
  if (!autoActive || !currentRouting || !VALID_TIERS.includes(currentRouting.tier)) {
    pendingRouting = null;
    return;
  }
  pendingRouting = {
    tier: currentRouting.tier,
    modelDowngraded: currentRouting.modelDowngraded === true,
  };
}

/**
 * Consume the pending snapshot for an assistant message_end. Returns a
 * same-role replacement carrying `modelRouting`, or undefined when the
 * message must not be decorated. Pending state is always cleared after
 * consumption so it cannot leak to another turn.
 */
export function consumeAssistantRoutingEnd<T extends { role?: unknown }>(
  message: T | null | undefined,
): (T & { modelRouting: ModelRouting }) | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const snapshot = pendingRouting;
  pendingRouting = null;
  if (!snapshot) return undefined;
  const modelRouting: ModelRouting = {
    source: "gsd-dynamic",
    tier: snapshot.tier as ModelRouting["tier"],
    modelDowngraded: snapshot.modelDowngraded,
  };
  return { ...message, modelRouting };
}

/** Drop any pending snapshot (session switch/reset/end boundaries). */
export function clearPendingModelRouting(): void {
  pendingRouting = null;
}
