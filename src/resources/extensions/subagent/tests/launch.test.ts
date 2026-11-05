// gsd-pi + Subagent launch module regression tests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";

import { SessionManager } from "@gsd/pi-coding-agent";
import subagentExtension from "../index.js";
import type { AgentConfig } from "../agents.js";
import {
	SUBAGENT_CHILD_ENV_VAR,
	SUBAGENT_CHILD_ENV_VALUE,
	SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR,
	buildShellEnvAssignments,
	buildShellEnvUnsets,
	buildSubagentProcessEnv,
	createSubagentLaunchPlan,
	isSubagentChildProcess,
	resolveSubagentProjectRoot,
	resolveSubagentSessionArgs,
} from "../launch.js";

// The shell-escaping test shells out to an external `bash` binary, which is
// commonly absent on Windows CI (and would throw ENOENT). Resolve a skip
// reason once so the suite stays portable without depending on bash.
function resolveBashSkipReason(): string | undefined {
	if (process.platform === "win32") return "bash is not available on Windows";
	try {
		execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
		return undefined;
	} catch {
		return "bash binary is not available";
	}
}

const BASH_SKIP_REASON = resolveBashSkipReason();

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "A test agent",
		systemPrompt: "",
		source: "project",
		filePath: "test-agent.md",
		tools: ["read", "write"],
		...overrides,
	};
}

function makeAssistantMessage() {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			total: 2,
			cost: { total: 0 },
		},
	} as any;
}

describe("subagent launch module", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("builds fresh child process args with child environment", () => {
		const agent = makeAgent({ model: "local-model" });
		const plan = createSubagentLaunchPlan({
			agent,
			task: "inspect the API",
			tmpPromptPath: "/tmp/prompt.md",
			defaultCwd: "/repo",
		});

		assert.ok(plan.args.includes("--no-session"));
		assert.equal(plan.args.includes("--session"), false);
		assert.equal(plan.env[SUBAGENT_CHILD_ENV_VAR], SUBAGENT_CHILD_ENV_VALUE);
		assert.equal(plan.cwd, "/repo");
		assert.deepEqual(plan.session, { mode: "fresh" });
		assert.deepEqual(plan.args.slice(plan.args.indexOf("--tools"), plan.args.indexOf("--tools") + 2), ["--tools", "read,write"]);
	});

	it("builds safe shell unsets for inherited cmux CUA capabilities", () => {
		const unsets = buildShellEnvUnsets({
			CMUX_CUA_SOCKET_PATH: "/test-only/socket",
			CMUX_CUA_SOCKET_HOST_AUTH_TOKEN: "test-only-token",
			CMUX_CUA_DEFAULT_SESSION: "test-only-session",
			KEEP_FOR_CHILD: "yes",
		});
		assert.equal(unsets.length % 2, 0);
		for (const name of [
			"CMUX_CUA_SOCKET_PATH",
			"CMUX_CUA_SOCKET_AUTH_TOKEN",
			"CMUX_CUA_SOCKET_HOST_AUTH_TOKEN",
			"CMUX_CUA_AUTH_TOKEN_FILE",
			"CMUX_CUA_DEFAULT_SESSION",
			"CMUX_CUA_STATE_OWNER_PID",
		]) {
			assert.ok(unsets.includes(name), `child shell must unset ${name}`);
		}
		assert.equal(unsets.includes("KEEP_FOR_CHILD"), false);
	});

	it("strips cmux CUA capabilities from child process environments", () => {
		const childEnv = buildSubagentProcessEnv({
			CMUX_CUA_SOCKET_PATH: "/test-only/socket",
			CMUX_CUA_AUTH_TOKEN_FILE: "/test-only/token-file",
			CMUX_CUA_DEFAULT_SESSION: "test-only-session",
			KEEP_FOR_CHILD: "yes",
		});

		assert.equal(childEnv[SUBAGENT_CHILD_ENV_VAR], SUBAGENT_CHILD_ENV_VALUE);
		assert.equal(childEnv.KEEP_FOR_CHILD, "yes");
		assert.deepEqual(Object.keys(childEnv).filter((name) => name.startsWith("CMUX_CUA_")), []);
	});

	it("propagates the parent authority to a nested repository child", (t) => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-subagent-parent-")));
		const child = join(dir, "frontend");
		mkdirSync(child);
		const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
		delete process.env.GSD_PROJECT_ROOT;
		t.after(() => {
			if (previousProjectRoot === undefined) delete process.env.GSD_PROJECT_ROOT;
			else process.env.GSD_PROJECT_ROOT = previousProjectRoot;
		});

		const plan = createSubagentLaunchPlan({
			agent: makeAgent(),
			task: "inspect the frontend",
			tmpPromptPath: null,
			defaultCwd: dir,
			cwd: child,
		});

		assert.equal(plan.env.GSD_PROJECT_ROOT, undefined);
		assert.equal(plan.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR], dir);
		assert.deepEqual(buildShellEnvAssignments(plan.env), [
			`${SUBAGENT_CHILD_ENV_VAR}='${SUBAGENT_CHILD_ENV_VALUE}'`,
			`${SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR}='${dir}'`,
		]);
	});

	it("does not propagate parent authority through a symlinked child path", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-subagent-symlink-")));
		const workspace = join(dir, "workspace");
		const externalRepo = join(dir, "external-repo");
		const linkedRepo = join(workspace, "linked-repo");
		mkdirSync(workspace);
		mkdirSync(externalRepo);
		symlinkSync(externalRepo, linkedRepo, "dir");

		const plan = createSubagentLaunchPlan({
			agent: makeAgent(),
			task: "inspect the linked repository",
			tmpPromptPath: null,
			defaultCwd: workspace,
			cwd: linkedRepo,
		});

		assert.equal(plan.cwd, externalRepo);
		assert.equal(plan.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR], undefined);
		assert.equal(resolveSubagentProjectRoot(workspace, linkedRepo), externalRepo);
	});

	it("does not propagate parent authority when the child cwd is missing", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-subagent-missing-")));
		const missingChild = join(dir, "missing-child");
		const plan = createSubagentLaunchPlan({
			agent: makeAgent(),
			task: "inspect the missing child",
			tmpPromptPath: null,
			defaultCwd: dir,
			cwd: missingChild,
		});

		assert.equal(plan.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR], undefined);
	});

	it("revalidates project authority after a child path becomes a symlink", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-subagent-delayed-symlink-")));
		const workspace = join(dir, "workspace");
		const child = join(workspace, "child");
		const externalRepo = join(dir, "external-repo");
		mkdirSync(child, { recursive: true });
		mkdirSync(externalRepo);
		const projectRoot = resolveSubagentProjectRoot(workspace, child);
		rmSync(child, { recursive: true });
		symlinkSync(externalRepo, child, "dir");

		const plan = createSubagentLaunchPlan({
			agent: makeAgent(),
			task: "inspect after the path changed",
			tmpPromptPath: null,
			defaultCwd: workspace,
			cwd: child,
			projectRoot,
		});

		assert.equal(plan.cwd, externalRepo);
		assert.equal(plan.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR], undefined);
	});

	it("shell-escapes cmux environment values without command execution", { skip: BASH_SKIP_REASON }, () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-shell-env-"));
		const marker = join(dir, "injected");
		const projectRoot = `space $HOME $(touch ${marker}) \`touch ${marker}\` 'quote'\nnext`;
		const assignments = buildShellEnvAssignments({
			[SUBAGENT_CHILD_ENV_VAR]: SUBAGENT_CHILD_ENV_VALUE,
			[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR]: projectRoot,
		});

		const output = execFileSync(
			"bash",
			["-lc", `env ${assignments.join(" ")} printenv ${SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR}`],
			{ encoding: "utf-8" },
		);

		assert.equal(output, `${projectRoot}\n`);
		assert.equal(existsSync(marker), false);
	});

	it("propagates explicit authority to an isolated child checkout", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-subagent-isolated-")));
		const workspace = join(dir, "workspace");
		const sourceCheckout = join(workspace, "source-checkout");
		const isolatedCheckout = join(dir, "isolated-checkout");
		mkdirSync(sourceCheckout, { recursive: true });
		mkdirSync(isolatedCheckout);
		const plan = createSubagentLaunchPlan({
			agent: makeAgent(),
			task: "inspect in isolation",
			tmpPromptPath: null,
			defaultCwd: workspace,
			cwd: isolatedCheckout,
			projectRoot: workspace,
			projectRootSourceCwd: sourceCheckout,
		});

		assert.equal(plan.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR], workspace);
	});

	it("removes stale runtime contract authority for an unrelated child cwd", (t) => {
		const previous = process.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR];
		process.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR] = "/stale-project";
		t.after(() => {
			if (previous === undefined) delete process.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR];
			else process.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR] = previous;
		});

		const plan = createSubagentLaunchPlan({
			agent: makeAgent(),
			task: "inspect another project",
			tmpPromptPath: null,
			defaultCwd: "/workspace",
			cwd: "/other-project",
		});

		assert.equal(plan.env[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR], undefined);
	});

	it("creates a real branched session for forked context", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-launch-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] } as any);
		manager.appendMessage(makeAssistantMessage());

		const session = resolveSubagentSessionArgs("fork", manager);

		assert.equal(session.mode, "fork");
		assert.ok(session.sessionFile);
		assert.notEqual(session.sessionFile, manager.getSessionFile());
		assert.equal(session.sessionDir, dir);
	});

	it("fails forked context loudly without a persisted parent session", () => {
		const manager = SessionManager.inMemory("/repo");
		assert.throws(
			() => resolveSubagentSessionArgs("fork", manager),
			/persisted parent session file/,
		);
	});

	it("marks child env and suppresses recursive tool registration", () => {
		const env = buildSubagentProcessEnv({});
		assert.equal(isSubagentChildProcess(env), true);

		const previous = process.env[SUBAGENT_CHILD_ENV_VAR];
		process.env[SUBAGENT_CHILD_ENV_VAR] = SUBAGENT_CHILD_ENV_VALUE;
		const calls: string[] = [];
		try {
			subagentExtension({
				on: () => calls.push("on"),
				registerCommand: () => calls.push("command"),
				registerTool: () => calls.push("tool"),
			} as any);
		} finally {
			if (previous === undefined) delete process.env[SUBAGENT_CHILD_ENV_VAR];
			else process.env[SUBAGENT_CHILD_ENV_VAR] = previous;
		}

		assert.deepEqual(calls, []);
	});
});
