/**
 * TUI config selector for `pi config` command
 */

import { ProcessTerminal, TuiMainScreen } from "@gsd/pi-tui";
import type { ResolvedPaths } from "@gsd/pi-coding-agent/core/package-manager.js";
import type { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.js";
import { initTheme, stopThemeWatcher } from "@gsd/pi-coding-agent/theme/theme.js";

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal());
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
