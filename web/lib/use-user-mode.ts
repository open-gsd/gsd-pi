"use client"

import { useCallback, useSyncExternalStore } from "react"

// ─── Types ──────────────────────────────────────────────────────────

export type UserMode = "expert" | "vibe-coder"

// ─── Storage ────────────────────────────────────────────────────────

const STORAGE_KEY = "gsd-user-mode"
const DEFAULT_MODE: UserMode = "expert"
let memoryMode: UserMode = DEFAULT_MODE
let hasUnpersistedMode = false

const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((cb) => cb())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): UserMode {
  if (typeof window === "undefined") return DEFAULT_MODE
  // A failed write must not let an older stored value undo this tab's choice.
  if (hasUnpersistedMode) return memoryMode
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    memoryMode = stored === "expert" || stored === "vibe-coder" ? stored : DEFAULT_MODE
  } catch {
    // Opaque embedded frames can deny access to the storage property itself.
  }
  return memoryMode
}

function getServerSnapshot(): UserMode {
  return DEFAULT_MODE
}

// ─── Imperative API (for use outside React) ─────────────────────────

/** Read current mode without a hook. Safe to call from event handlers. */
export function getUserMode(): UserMode {
  return getSnapshot()
}

/** Update this tab's mode, persist when available, and notify subscribers. */
export function setUserMode(mode: UserMode): void {
  memoryMode = mode
  try {
    localStorage.setItem(STORAGE_KEY, mode)
    hasUnpersistedMode = false
  } catch {
    hasUnpersistedMode = true
  }
  notify()
}

/** Revert to the default, clearing the persisted preference when available. */
export function clearUserMode(): void {
  memoryMode = DEFAULT_MODE
  try {
    localStorage.removeItem(STORAGE_KEY)
    hasUnpersistedMode = false
  } catch {
    hasUnpersistedMode = true
  }
  notify()
}

// ─── React Hook ─────────────────────────────────────────────────────

export function useUserMode(): [UserMode, (mode: UserMode) => void] {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const set = useCallback((m: UserMode) => setUserMode(m), [])
  return [mode, set]
}
