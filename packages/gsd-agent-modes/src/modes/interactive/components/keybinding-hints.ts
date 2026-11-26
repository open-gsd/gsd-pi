/**
 * Utilities for formatting keybinding hints in the UI.
 */

import {
	type EditorAction,
	getEditorKeybindings,
	getKeybindings,
	type Keybinding,
	type KeyId,
} from "@gsd/pi-tui";
import type { AppAction, KeybindingsManager } from "@gsd/agent-core";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";

const isMac = process.platform === "darwin";

/**
 * Convert a key identifier to a platform-appropriate display string.
 * On macOS, "alt+" is shown as "⌥" (Option key symbol).
 */
export function formatKeyForDisplay(key: string): string {
	if (!isMac) return key;
	return key.replace(/\balt\+/gi, "⌥");
}

/**
 * Format keys array as display string (e.g., ["ctrl+c", "escape"] -> "ctrl+c/escape").
 * Applies platform-specific formatting (e.g., alt -> ⌥ on macOS).
 */
function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return formatKeyForDisplay(keys[0]!);
	return keys.map(formatKeyForDisplay).join("/");
}

function isDottedKeybinding(action: string): action is Keybinding {
	return action.includes(".");
}

/**
 * Get display string for an editor action.
 */
export function editorKey(action: EditorAction): string {
	return formatKeys(getEditorKeybindings().getKeys(action));
}

/**
 * Get display string for a global/app keybinding id (e.g. "app.tools.expand").
 * Also accepts legacy EditorAction names used by GSD interactive components.
 */
export function keyText(keybinding: Keybinding | EditorAction | string): string {
	if (isDottedKeybinding(keybinding)) {
		return formatKeys(getKeybindings().getKeys(keybinding));
	}
	return editorKey(keybinding as EditorAction);
}

/**
 * Get display string for an app action.
 */
export function appKey(keybindings: KeybindingsManager, action: AppAction): string {
	return formatKeys(keybindings.getKeys(action));
}

/**
 * Format a keybinding hint with consistent styling: dim key, muted description.
 * Accepts dotted Keybinding ids (upstream v1.6.1) or legacy EditorAction names.
 *
 * @param action - Keybinding id (e.g. "app.tools.expand") or editor action (e.g. "expandTools")
 * @param description - Description text (e.g., "to expand", "cancel")
 * @returns Formatted string with dim key and muted description
 */
export function keyHint(action: Keybinding | EditorAction | string, description: string): string {
	return theme.fg("dim", keyText(action)) + theme.fg("muted", ` ${description}`);
}

/**
 * Format a keybinding hint for app-level actions.
 * Requires the KeybindingsManager instance.
 *
 * @param keybindings - KeybindingsManager instance
 * @param action - App action name (e.g., "interrupt", "externalEditor")
 * @param description - Description text
 * @returns Formatted string with dim key and muted description
 */
export function appKeyHint(keybindings: KeybindingsManager, action: AppAction, description: string): string {
	return theme.fg("dim", appKey(keybindings, action)) + theme.fg("muted", ` ${description}`);
}

/** Standard selector footer used by interactive list dialogs. */
export function selectorFooter(confirmLabel = "select", cancelLabel = "cancel"): string {
	const sep = theme.fg("dim", "  ·  ");
	return rawKeyHint("↑↓", "navigate") + sep + keyHint("selectConfirm", confirmLabel) + sep + keyHint("selectCancel", cancelLabel);
}

/**
 * Format a raw key string with description (for non-configurable keys like ↑↓).
 *
 * @param key - Raw key string
 * @param description - Description text
 * @returns Formatted string with dim key and muted description
 */
export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}
