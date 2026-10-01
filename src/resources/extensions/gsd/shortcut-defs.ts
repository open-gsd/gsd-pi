// Canonical GSD shortcut definitions used by registration, help text, and overlays.

import { formatShortcut } from "./files.js";
import { supportsCtrlAltShortcuts } from "../shared/terminal.js";

export type GSDShortcutId = "dashboard" | "notifications" | "parallel";

type GSDShortcutDef = {
  key: "g" | "n" | "p";
  action: string;
  command: string;
  /** Whether the Alt fallback is registered (false when it would shadow an app meta-arrow alias). */
  hasFallback: boolean;
};

export const GSD_SHORTCUTS: Record<GSDShortcutId, GSDShortcutDef> = {
  dashboard: {
    key: "g",
    action: "Open GSD dashboard",
    command: "/gsd status",
    hasFallback: true,
  },
  notifications: {
    key: "n",
    action: "Open notification history",
    command: "/gsd notifications",
    hasFallback: true,
  },
  parallel: {
    key: "p",
    action: "Open parallel worker monitor",
    command: "/gsd parallel watch",
    hasFallback: false, // ESC+P aliases to alt+up (app.models.reorderUp) on legacy terminals
  },
};

function combo(prefix: "Ctrl+Alt+" | "Alt+", key: string): string {
  return `${prefix}${key.toUpperCase()}`;
}

export function primaryShortcutCombo(id: GSDShortcutId): string {
  return combo("Ctrl+Alt+", GSD_SHORTCUTS[id].key);
}

export function fallbackShortcutCombo(id: GSDShortcutId): string {
  return combo("Alt+", GSD_SHORTCUTS[id].key);
}

/**
 * Advertised pair for a shortcut. alt+<key> is the legacy-reachable family
 * (ESC-prefix path in pi-tui matching, CSI-u on modern terminals), so in
 * terminals flagged as unable to fire Ctrl+Alt chords we advertise only the
 * Alt fallback instead of a chord that cannot be emitted there.
 */
export function shortcutPair(id: GSDShortcutId, formatter: (combo: string) => string = (combo) => combo): string {
  const fallback = formatter(fallbackShortcutCombo(id));
  if (!GSD_SHORTCUTS[id].hasFallback) return formatter(primaryShortcutCombo(id));
  if (!supportsCtrlAltShortcuts()) return fallback;
  return `${formatter(primaryShortcutCombo(id))} / ${fallback}`;
}

export function formattedShortcutPair(id: GSDShortcutId): string {
  return shortcutPair(id, formatShortcut);
}
