// Project/App: gsd-pi
// File Purpose: Semantic VS Code theme tokens for the sidebar webview's color
// roles, shared by the webview render and unit tests (issue #2929).
//
// Fixed hex colors do not adapt to the active editor theme, so each remaining
// color role resolves to a semantic editor token through the `--vscode-*`
// custom properties VS Code injects into webviews, letting light, dark and
// high-contrast themes supply the values. Token choice alone makes no
// universal contrast guarantee; the non-color cues (status label text, button
// labels, context percentage) carry the meaning and color only reinforces
// them.

/**
 * Connection/status indicator color for the sidebar header: online resolves
 * to the same passing token the activity feed uses for success outcomes;
 * offline to the general error indicator token. Kept as a function so the
 * decision itself is executable by the unit tests (the webview template
 * module needs the vscode host).
 */
export function sidebarStatusColor(connected: boolean): string {
	return connected ? SIDEBAR_STATUS_ONLINE_COLOR : SIDEBAR_STATUS_OFFLINE_COLOR;
}

export const SIDEBAR_STATUS_ONLINE_COLOR = "var(--vscode-testing-iconPassed)";

export const SIDEBAR_STATUS_OFFLINE_COLOR = "var(--vscode-errorForeground)";

/** Destructive-action accent (buttons that stop or discard work). */
export const SIDEBAR_DANGER_COLOR = "var(--vscode-errorForeground)";

/**
 * Progress/usage meter fill. The meter stays readable in high-contrast themes
 * structurally: the track is transparent with a panel-border outline, so the
 * unfilled remainder shows the webview background instead of colliding with
 * the fill color (progressBar.background resolves to contrastBorder in the
 * high-contrast themes, exactly like panel.border would).
 */
export const SIDEBAR_PROGRESS_COLOR = "var(--vscode-progressBar-background)";
