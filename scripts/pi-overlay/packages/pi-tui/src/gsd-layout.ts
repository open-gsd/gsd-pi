import { truncateToWidth, visibleWidth } from "./utils.js";

/** Pad a string with trailing spaces to fill `width` (ANSI-aware). */
export function padRight(content: string, width: number): string {
	const vis = visibleWidth(content);
	return content + " ".repeat(Math.max(0, width - vis));
}

/** Build a line with left-aligned and right-aligned content within `width`. */
export function alignRight(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	if (leftW + rightW > width) {
		return truncateToWidth(`${left}${right}`, width);
	}
	return left + " ".repeat(width - leftW - rightW) + right;
}