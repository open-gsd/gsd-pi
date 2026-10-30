// Fixed package limits; no caller-controlled runtime policy.
export const MAINTENANCE_LIMITS = Object.freeze({ frameBytes: 65_536, totalBytes: 262_144, frames: 16, lifetimeMs: 60_000, cleanupMs: 1_000 });
