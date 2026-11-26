import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../pi-ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../pi-ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../pi-agent-core/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../pi-tui/src/index.ts", import.meta.url));
const codingAgentIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		env: { PI_OFFLINE: "1" },
		unstubEnvs: true,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@gsd\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@gsd\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@gsd\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@gsd\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@gsd\/pi-coding-agent$/, replacement: codingAgentIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
