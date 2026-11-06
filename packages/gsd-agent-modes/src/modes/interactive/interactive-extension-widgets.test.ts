import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { inferLocalInteractiveDesktop, setExtensionWidget } from "./interactive-extension-widgets.js";

function createWidgetHost() {
	const renderCalls: Array<true | undefined> = [];
	return {
		host: {
			extensionWidgetsAbove: new Map(),
			extensionWidgetsBelow: new Map(),
			// Leave widget containers undefined so renderWidgets() returns early,
			// isolating only the gsd-outcome force-render path under test.
			widgetContainerAbove: undefined,
			widgetContainerBelow: undefined,
			pinnedMessageContainer: { children: [] },
			ui: {
				requestRender(force?: boolean) {
					if (force) renderCalls.push(true);
				},
			},
		} as any,
		renderCalls,
	};
}

test("local desktop admission requires the default process terminal and a TTY host", () => {
	assert.equal(inferLocalInteractiveDesktop(undefined, true, true), true);
	assert.equal(inferLocalInteractiveDesktop({ columns: 80 }, true, true), false);
	assert.equal(inferLocalInteractiveDesktop(null, true, true), false);
	assert.equal(inferLocalInteractiveDesktop(undefined, false, true), false);
	assert.equal(inferLocalInteractiveDesktop(undefined, true, false), false);
});

test("setExtensionWidget: forces viewport realign when key is gsd-outcome", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-outcome", ["Step complete"]);
	assert.equal(renderCalls.length, 1, "requestRender(true) should be called once for gsd-outcome");
});

test("setExtensionWidget: does not force viewport realign for non-gsd-outcome keys", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-other", ["Working..."]);
	assert.equal(renderCalls.length, 0, "requestRender(true) should not be called for non-gsd-outcome keys");
});

test("setExtensionWidget: does not force viewport realign when removing a widget (content undefined)", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-outcome", undefined);
	assert.equal(renderCalls.length, 0, "requestRender(true) should not be called when content is undefined");
});
