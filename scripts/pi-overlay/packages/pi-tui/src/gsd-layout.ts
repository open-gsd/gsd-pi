import { truncateToWidth, visibleWidth } from "./utils.js";

/**
 * Pad text to a target visible width (GSD compat).
 * Clips with truncateToWidth first so over-wide ANSI rows stay on the width contract.
 */
export function padRight(text: string, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	const clipped = truncateToWidth(text, targetWidth, "");
	return clipped + " ".repeat(Math.max(0, targetWidth - visibleWidth(clipped)));
}

/** Place right text against the right edge while preserving ANSI-aware width. */
export function alignRight(left: string, right: string, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth <= 0) return "";
	if (!right) return truncateToWidth(left, targetWidth, "");
	const gap = Math.max(1, targetWidth - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, targetWidth, "");
}
