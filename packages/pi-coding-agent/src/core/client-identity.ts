import { type ClientIdentity, PI_ATTRIBUTION } from "@gsd/pi-ai";
import { VERSION } from "../config.js";
import type { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";

/**
 * How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and attribution to pi as a
 * CLI agent while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager) ? PI_ATTRIBUTION : null,
	};
}
