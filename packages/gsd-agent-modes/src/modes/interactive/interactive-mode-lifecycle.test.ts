// gsd-pi + packages/pi-coding-agent/src/modes/interactive/interactive-mode-lifecycle.test.ts - InteractiveMode lifecycle regression coverage.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode } from "./interactive-mode.js";
import { ProducerActivityFooterCache } from "./producer-activity-footer-cache.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

initTheme("dark", false);

type RuntimeInteractiveMode = {
	[key: string]: unknown;
	stop(): void;
	_themeChangeUnsub?: () => void;
	getMarkdownThemeWithSettings(): unknown;
};

describe("InteractiveMode lifecycle", () => {
	it("calls and clears the theme-change unsubscriber on stop", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let unsubscribeCount = 0;

		mode.loadingAnimation = undefined;
		mode.extensionTerminalInputUnsubscribers = new Set();
		mode.clearExtensionTerminalInputListeners = () => {};
		mode._branchChangeUnsub = undefined;
		mode._themeChangeUnsub = () => {
			unsubscribeCount++;
		};
		mode.onInputCallback = undefined;
		mode.clearExtensionWidgets = () => {};
		mode.customFooter = undefined;
		mode.customHeader = undefined;
		mode.footer = { dispose() {} };
		mode.footerDataProvider = { dispose() {} };
		mode.unsubscribe = undefined;
		mode.isInitialized = false;

		mode.stop();

		assert.equal(unsubscribeCount, 1);
		assert.equal(mode._themeChangeUnsub, undefined);
	});

	it("caches markdown theme settings until the code block indent changes", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let codeBlockIndent = "  ";
		mode.session = {
			settingsManager: {
				getCodeBlockIndent: () => codeBlockIndent,
			},
		};

		const first = mode.getMarkdownThemeWithSettings();
		assert.equal(mode.getMarkdownThemeWithSettings(), first);

		codeBlockIndent = "    ";
		const updated = mode.getMarkdownThemeWithSettings() as { codeBlockIndent: string };

		assert.notEqual(updated, first);
		assert.equal(updated.codeBlockIndent, "    ");
		assert.equal(mode.getMarkdownThemeWithSettings(), updated);
	});
});

// Regression (PR #3146 review): an earlier transition's settled used to refresh the
// footer while a later owner transition was still pending, publishing the old owner.
describe("producer activity owner-transition overlap", () => {
	type Lifecycle = {
		activeOwnerTransitions: number;
		producerActivity: ProducerActivityFooterCache | undefined;
		session: { extensionRunner: unknown };
		ui: { requestRender(): void };
		isShuttingDown: boolean;
		applyProducerActivityLifecycle(event: unknown): void;
		refreshProducerActivity(): Promise<void>;
		resetProducerActivityForSessionChange(): void;
	};
	const starting = { type: "owner_generation_transition", phase: "starting" };
	const settled = { type: "owner_generation_transition", phase: "settled" };

	function harness(readsPerRunner: { count: number }) {
		const mode = Object.create(InteractiveMode.prototype) as Lifecycle;
		mode.activeOwnerTransitions = 0;
		mode.producerActivity = new ProducerActivityFooterCache();
		mode.session = { extensionRunner: null };
		mode.ui = { requestRender() {} };
		mode.isShuttingDown = false;
		return { mode, readsPerRunner };
	}

	it("does not publish after an earlier settled while a later transition is pending", async () => {
		const { mode } = harness({ count: 0 });
		mode.applyProducerActivityLifecycle(starting); // A starts
		mode.applyProducerActivityLifecycle(starting); // B starts, still pending
		mode.applyProducerActivityLifecycle(settled); // A settles while B is pending
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(mode.activeOwnerTransitions, 1);
		assert.deepEqual(mode.producerActivity!.snapshot().lines, []);
		assert.equal(mode.producerActivity!.snapshot().refreshedAt, null, "no refresh while B is pending");
	});

	it("refreshes once the last outstanding transition settles", async () => {
		const { mode } = harness({ count: 0 });
		let refreshes = 0;
		mode.session = { extensionRunner: null };
		const real = mode.refreshProducerActivity.bind(mode);
		mode.refreshProducerActivity = async () => {
			refreshes += 1;
			return real();
		};
		mode.applyProducerActivityLifecycle(starting);
		mode.applyProducerActivityLifecycle(starting);
		mode.applyProducerActivityLifecycle(settled);
		mode.applyProducerActivityLifecycle(settled); // B settles: count reaches zero
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(mode.activeOwnerTransitions, 0);
		assert.equal(refreshes, 1, "exactly one refresh, after the last settle");
	});

	it("ignores an unmatched settled at zero", () => {
		const { mode } = harness({ count: 0 });
		mode.applyProducerActivityLifecycle(settled);
		assert.equal(mode.activeOwnerTransitions, 0);
	});
});
