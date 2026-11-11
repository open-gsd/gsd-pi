// Fixed package limits; no caller-controlled runtime policy.
export const MAINTENANCE_LIMITS = Object.freeze({ frameBytes: 65_536, totalBytes: 262_144, frames: 16, lifetimeMs: 60_000, cleanupMs: 1_000 });

// Separate budgets; framed JSON limits above are intentionally unchanged.
export const ATTENDED_MAINTENANCE_LIMITS = Object.freeze({ reviewMs: 600_000, writeMs: 60_000, cleanupMs: 1_000 });
