// Project/App: gsd-pi
// File Purpose: Verifies the sidebar webview's color roles resolve through
// semantic VS Code editor tokens instead of fixed hex colors (issue #2929).
// Semantic `--vscode-*` tokens are what let light, dark and high-contrast
// editor themes supply values; a fixed hex color would ignore the active
// theme again.

import test from "node:test";
import assert from "node:assert/strict";
import {
	SIDEBAR_DANGER_COLOR,
	SIDEBAR_PROGRESS_COLOR,
	SIDEBAR_STATUS_OFFLINE_COLOR,
	SIDEBAR_STATUS_ONLINE_COLOR,
	sidebarStatusColor,
} from "../src/semantic-colors.ts";

test("status color decision resolves connected and disconnected to their semantic tokens", () => {
	assert.equal(sidebarStatusColor(true), SIDEBAR_STATUS_ONLINE_COLOR);
	assert.equal(sidebarStatusColor(false), SIDEBAR_STATUS_OFFLINE_COLOR);
});

test("every sidebar color role is a semantic --vscode- token, never a hex literal", () => {
	for (const [role, value] of [
		["status online", SIDEBAR_STATUS_ONLINE_COLOR],
		["status offline", SIDEBAR_STATUS_OFFLINE_COLOR],
		["danger action", SIDEBAR_DANGER_COLOR],
		["progress fill", SIDEBAR_PROGRESS_COLOR],
	] as const) {
		assert.match(value, /^var\(--vscode-[a-zA-Z-]+\)$/, `${role} must be a semantic editor token`);
		assert.doesNotMatch(value, /#[0-9a-fA-F]{3,8}\b/, `${role} must not hard-code a hex color`);
	}
});

test("the semantic mapping pins each role to its editor token", () => {
	// Status vocabulary aligns with the activity feed: success/online uses the
	// same passing token; offline and destructive actions use the general error
	// indicator; meters use the progress-bar token (the track stays transparent
	// with a panel-border outline so high-contrast themes, where both tokens
	// resolve to contrastBorder, still distinguish unfilled from filled).
	assert.equal(SIDEBAR_STATUS_ONLINE_COLOR, "var(--vscode-testing-iconPassed)");
	assert.equal(SIDEBAR_STATUS_OFFLINE_COLOR, "var(--vscode-errorForeground)");
	assert.equal(SIDEBAR_DANGER_COLOR, "var(--vscode-errorForeground)");
	assert.equal(SIDEBAR_PROGRESS_COLOR, "var(--vscode-progressBar-background)");
});
