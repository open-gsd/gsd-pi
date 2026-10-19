// gsd-pi — Readiness contract for every external-CLI provider and every model.
//
// The TUI asks "is this provider ready?" once per model whenever it lists
// models (`ModelRegistry.getAvailable()`), and the answer used to come from a
// synchronous child process: seconds of frozen UI on Windows. This suite loads
// the real provider extensions (Claude Code, Cursor Agent, Gemini CLI,
// Antigravity) into a real ModelRegistry, points them at fake CLIs on PATH,
// and proves for every model each of them registers that:
//
//   - a cold cache lists no model, and nothing is spawned on the caller's stack
//   - one asynchronous probe makes all of the provider's models available,
//     however many models there are and however often the list is asked for
//   - a stale cache keeps answering from the last probe (no spawn on the
//     caller's stack) and the asynchronous refresh then updates every model
//   - no synchronous child process is ever used

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ModelRegistry } from "../../packages/pi-coding-agent/src/core/model-registry.ts";
import claudeCodeCli from "../resources/extensions/claude-code-cli/index.ts";
import { buildClaudeCodeModelList } from "../resources/extensions/claude-code-cli/models.ts";
import { clearReadinessCache } from "../resources/extensions/claude-code-cli/readiness.ts";
import cursorCli from "../resources/extensions/cursor-cli/index.ts";
import { CURSOR_AGENT_MODELS } from "../resources/extensions/cursor-cli/models.ts";
import { clearCursorAgentReadinessCache } from "../resources/extensions/cursor-cli/readiness.ts";
import googleCli from "../resources/extensions/google-cli/index.ts";
import { GOOGLE_ANTIGRAVITY_MODELS, GOOGLE_GEMINI_CLI_MODELS } from "../resources/extensions/google-cli/models.ts";
import { clearGoogleCliReadinessCache } from "../resources/extensions/google-cli/readiness.ts";

const IS_WINDOWS = process.platform === "win32";
const ENV_KEYS = ["PATH", "CLAUDE_TEST_AUTH", "CURSOR_AGENT_TEST_AUTH", "CURSOR_API_KEY", "GSD_CURSOR_DISABLE"] as const;

interface ProviderCase {
	/** Provider id as registered with the model registry. */
	id: string;
	/** Binary the provider probes. */
	binary: string;
	/** Model ids the extension registers for this provider. */
	modelIds: () => string[];
	/** Child processes one full readiness probe is allowed to spawn. */
	spawnsPerProbe: number;
	/** Make the (fake) CLI stop being ready: log out, or uninstall. */
	makeUnready: (fixtureDir: string) => void;
}

function uninstall(binary: string): (fixtureDir: string) => void {
	return (fixtureDir) => rmSync(join(fixtureDir, IS_WINDOWS ? `${binary}.cmd` : binary), { force: true });
}

const PROVIDERS: ProviderCase[] = [
	{
		id: "claude-code",
		binary: "claude",
		modelIds: () => buildClaudeCodeModelList().map((model) => model.id),
		spawnsPerProbe: 2, // --version, auth status --json
		makeUnready: () => {
			process.env.CLAUDE_TEST_AUTH = "out";
		},
	},
	{
		id: "cursor-agent",
		binary: "cursor-agent",
		modelIds: () => CURSOR_AGENT_MODELS.map((model) => model.id),
		spawnsPerProbe: 2, // --version, status
		makeUnready: () => {
			process.env.CURSOR_AGENT_TEST_AUTH = "out";
		},
	},
	{
		id: "google-gemini-cli",
		binary: "gemini",
		modelIds: () => GOOGLE_GEMINI_CLI_MODELS.map((model) => model.id),
		spawnsPerProbe: 1, // where/which gemini
		makeUnready: uninstall("gemini"),
	},
	{
		id: "google-antigravity",
		binary: "agy",
		modelIds: () => GOOGLE_ANTIGRAVITY_MODELS.map((model) => model.id),
		spawnsPerProbe: 1, // where/which agy
		makeUnready: uninstall("agy"),
	},
];

/** Fake CLI whose auth subcommand reports "in"/"out" from an env variable. */
function writeFakeAuthCli(dir: string, binary: string, authArg: string, authEnv: string, loggedIn: string, loggedOut: string): void {
	if (IS_WINDOWS) {
		writeFileSync(join(dir, `${binary}.cmd`), [
			"@echo off",
			"if \"%1\"==\"--version\" (echo 1.0.0 & exit /b 0)",
			`if not "%1"=="${authArg}" exit /b 1`,
			`if "%${authEnv}%"=="in" (echo ${loggedIn} & exit /b 0)`,
			`echo ${loggedOut}`,
			"exit /b 0",
		].join("\r\n"));
		return;
	}
	writeFileSync(join(dir, binary), [
		"#!/bin/sh",
		"[ \"$1\" = \"--version\" ] && { echo 1.0.0; exit 0; }",
		`[ "$1" = "${authArg}" ] || exit 1`,
		`[ "$${authEnv}" = "in" ] && { echo '${loggedIn}'; exit 0; }`,
		`echo '${loggedOut}'`,
		"exit 0",
	].join("\n"), { mode: 0o755 });
}

/** Fake CLI that only needs to exist on PATH. */
function writeFakePresenceCli(dir: string, binary: string): void {
	if (IS_WINDOWS) writeFileSync(join(dir, `${binary}.cmd`), "@echo off\r\necho mock\r\n");
	else writeFileSync(join(dir, binary), "#!/bin/sh\necho mock\n", { mode: 0o755 });
}

/** PATH holding only the fake CLIs plus what the probes themselves need (cmd/where, sh/which). */
function hermeticPath(fixtureDir: string): string {
	const systemDirs = IS_WINDOWS
		? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
		: ["/usr/bin", "/bin"];
	return [fixtureDir, ...systemDirs].join(delimiter);
}

function createAuthStorage(): any {
	return {
		setFallbackResolver: () => {},
		onCredentialChange: () => {},
		getOAuthProviders: () => [],
		get: () => undefined,
		hasAuth: () => false,
		getApiKey: async () => undefined,
	};
}

describe("external-CLI provider readiness for every model", () => {
	type AnyFn = (...args: any[]) => any;
	const patchable = childProcess as unknown as Record<string, AnyFn>;
	const SYNC_SPAWN_APIS = ["execFileSync", "spawnSync", "execSync"];
	let originals: Record<string, AnyFn>;
	let syncSpawns: string[];
	let asyncSpawns: string[];
	let fixtureDir: string;
	let savedEnv: Record<string, string | undefined>;
	let registry: ModelRegistry;

	/** Asynchronous child processes spawned so far to probe `binary`. */
	function probeSpawns(binary: string): number {
		const pattern = new RegExp(`(^|[\\s\\\\/])${binary}(\\.cmd)?(\\s|$)`);
		return asyncSpawns.filter((spawn) => pattern.test(spawn)).length;
	}

	function availableModelIds(providerId: string): string[] {
		return registry.getAvailable().filter((model) => model.provider === providerId).map((model) => model.id);
	}

	beforeEach(() => {
		// Record every child process: synchronous ones are forbidden outright,
		// asynchronous ones are counted so "one probe for all models" is checkable.
		syncSpawns = [];
		asyncSpawns = [];
		originals = {};
		for (const api of SYNC_SPAWN_APIS) {
			originals[api] = patchable[api];
			patchable[api] = (...args: unknown[]) => {
				syncSpawns.push(`${api}(${String(args[0])})`);
				throw new Error(`${api} must not be used to decide provider readiness`);
			};
		}
		originals.execFile = patchable.execFile;
		patchable.execFile = (...args: any[]) => {
			asyncSpawns.push([args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(" "));
			return originals.execFile(...args);
		};
		syncBuiltinESMExports();

		fixtureDir = mkdtempSync(join(tmpdir(), "cli-readiness-all-models-"));
		writeFakeAuthCli(fixtureDir, "claude", "auth", "CLAUDE_TEST_AUTH", "Logged in as user@example.com", "Not logged in");
		writeFakeAuthCli(fixtureDir, "cursor-agent", "status", "CURSOR_AGENT_TEST_AUTH", "Authenticated as user@example.com", "Not authenticated");
		writeFakePresenceCli(fixtureDir, "gemini");
		writeFakePresenceCli(fixtureDir, "agy");

		savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PATH = hermeticPath(fixtureDir);
		process.env.CLAUDE_TEST_AUTH = "in";
		process.env.CURSOR_AGENT_TEST_AUTH = "in";
		delete process.env.CURSOR_API_KEY;
		delete process.env.GSD_CURSOR_DISABLE;

		clearReadinessCache();
		clearCursorAgentReadinessCache();
		clearGoogleCliReadinessCache();

		// Load the real extensions into a real registry, as startup does.
		registry = new ModelRegistry(createAuthStorage(), join(fixtureDir, "models.json"));
		const pi = {
			on() {},
			registerProvider: (name: string, config: Parameters<ModelRegistry["registerProvider"]>[1]) =>
				registry.registerProvider(name, config),
			unregisterProvider: (name: string) => registry.unregisterProvider(name),
		};
		claudeCodeCli(pi as never);
		cursorCli(pi as never);
		googleCli(pi as never);
	});

	afterEach(async () => {
		// Let the probes primed at registration finish before the fixture goes away.
		await registry.settleProviderReadiness();
		for (const [api, original] of Object.entries(originals)) patchable[api] = original;
		syncBuiltinESMExports();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		clearReadinessCache();
		clearCursorAgentReadinessCache();
		clearGoogleCliReadinessCache();
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	test("every provider registers the models this suite covers", () => {
		for (const provider of PROVIDERS) {
			const registered = registry.getAll().filter((model) => model.provider === provider.id).map((model) => model.id);
			assert.ok(registered.length > 0, `${provider.id} registers at least one model`);
			assert.deepEqual(registered.sort(), provider.modelIds().sort(), `${provider.id} catalog`);
		}
	});

	for (const provider of PROVIDERS) {
		describe(provider.id, () => {
			test("cold cache: no model is available and nothing is spawned on the caller's stack", () => {
				// Registration primed the caches; start from a provably cold one.
				clearReadinessCache();
				clearCursorAgentReadinessCache();
				clearGoogleCliReadinessCache();
				const spawnsBefore = probeSpawns(provider.binary);

				for (const modelId of provider.modelIds()) {
					assert.equal(registry.isProviderRequestReady(provider.id), false, `${provider.id}/${modelId} on a cold cache`);
				}
				assert.deepEqual(availableModelIds(provider.id), [], "unknown must not be reported as ready");
				assert.equal(probeSpawns(provider.binary), spawnsBefore, "the probe must not start inside the synchronous call");
				assert.deepEqual(syncSpawns, []);
			});

			test("one async probe makes every model available, however often the list is asked for", async () => {
				// A model selector asks once per model, and re-asks on every open.
				for (let i = 0; i < 10; i++) availableModelIds(provider.id);

				await registry.settleProviderReadiness(provider.id);

				for (let i = 0; i < 10; i++) {
					assert.deepEqual(availableModelIds(provider.id).sort(), provider.modelIds().sort());
				}
				assert.equal(
					probeSpawns(provider.binary),
					provider.spawnsPerProbe,
					`${provider.modelIds().length} models x 20 listings must cost one probe, not one per model or per call`,
				);
				assert.deepEqual(syncSpawns, []);
			});

			test("stale cache: every model keeps its last answer without a spawn, then the async refresh updates them all", async (t) => {
				t.mock.timers.enable({ apis: ["Date"] });
				await registry.settleProviderReadiness(provider.id);
				assert.deepEqual(availableModelIds(provider.id).sort(), provider.modelIds().sort());
				const spawnsBefore = probeSpawns(provider.binary);

				// The CLI stops being usable, and the 30 s cache window expires.
				provider.makeUnready(fixtureDir);
				t.mock.timers.tick(31_000);

				for (let i = 0; i < 10; i++) {
					assert.deepEqual(
						availableModelIds(provider.id).sort(),
						provider.modelIds().sort(),
						"a stale cache still answers with the last known value for every model",
					);
				}
				assert.equal(probeSpawns(provider.binary), spawnsBefore, "no probe ran on the caller's stack");

				await registry.settleProviderReadiness(provider.id);

				assert.deepEqual(availableModelIds(provider.id), [], "the refresh reached every model of the provider");
				assert.equal(registry.isProviderRequestReady(provider.id), false);
				assert.equal(
					probeSpawns(provider.binary),
					spawnsBefore + provider.spawnsPerProbe,
					"the whole stale window cost exactly one refresh",
				);
				assert.deepEqual(syncSpawns, []);
			});
		});
	}
});
