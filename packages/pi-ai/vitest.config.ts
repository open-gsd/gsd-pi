import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../pi-telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@gsd\/pi-telemetry$/, replacement: telemetrySrcIndex }],
		// Workspace packages without a build (pi-schema) resolve to their source.
		conditions: ["source"],
	},
	ssr: { resolve: { conditions: ["source"] } },
});