import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../pi-telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../pi-ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../pi-ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@gsd\/pi-telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@gsd\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@gsd\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@gsd\/pi-ai\/compat$/, replacement: aiSrcCompat },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
