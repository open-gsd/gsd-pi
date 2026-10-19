// gsd-pi — Guided workflow Unit context.
// Tracks the guided Unit whose queued turn should use manifest Tool Contract policy.

import { kernelSettleUnitClaim } from "./auto/lifecycle-kernel.js";

/** The kernel claim of the unit the context's turn runs (ADR-048 one-unit bound). */
export interface GuidedKernelClaim {
  dispatchId: number;
  workerId: string;
  milestoneId: string;
  leaseToken: number;
}

export interface GuidedUnitContext {
  basePath: string;
  unitType: string;
  startedAt: number;
  kernelClaim?: GuidedKernelClaim;
}

const guidedUnitContextByBasePath = new Map<string, GuidedUnitContext>();

export function setGuidedUnitContext(basePath: string, unitType: string): GuidedUnitContext {
  const context = { basePath, unitType, startedAt: Date.now() };
  guidedUnitContextByBasePath.set(basePath, context);
  return context;
}

export function getGuidedUnitContext(basePath?: string): GuidedUnitContext | null {
  if (basePath) return guidedUnitContextByBasePath.get(basePath) ?? null;
  if (guidedUnitContextByBasePath.size === 1) return guidedUnitContextByBasePath.values().next().value!;
  return null;
}

export function clearGuidedUnitContext(basePath?: string): void {
  if (basePath) {
    guidedUnitContextByBasePath.delete(basePath);
  } else {
    guidedUnitContextByBasePath.clear();
  }
}

/**
 * Settle the kernel claim the guided unit's turn still holds, so the milestone
 * lease is released before an agent-end handler (the discuss-to-auto handoff)
 * can claim it. The dispatch path settles its own claim when the send
 * resolves; the first settle detaches the claim, so a second call is a no-op.
 */
export function settleGuidedKernelClaim(basePath?: string): void {
  const context = getGuidedUnitContext(basePath);
  const claim = context?.kernelClaim;
  if (!claim) return;
  delete context.kernelClaim;
  kernelSettleUnitClaim(
    { kind: "claimed", ...claim },
    "completed",
    "guided-flow",
  );
}
