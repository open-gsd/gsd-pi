import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage, BashExecutionMessage } from "../../src/core/messages.ts";
import { CURRENT_SESSION_VERSION, findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("truncates and rewrites file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		// File with messages but no session header (corrupted state)
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		);

		const sm = SessionManager.open(noHeaderFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain only a valid header (old content truncated)
		const content = readFileSync(noHeaderFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of recovered file work correctly", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		writeFileSync(corruptedFile, "garbage content\n");

		// First open recovers the file
		const sm1 = SessionManager.open(corruptedFile, tempDir);
		const sessionId = sm1.getSessionId();

		// Second open should load the recovered file successfully
		const sm2 = SessionManager.open(corruptedFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});

describe("SessionManager.openExisting", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-exact-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function sessionHeader(id: string, cwd: string, version = CURRENT_SESSION_VERSION): string {
		return JSON.stringify({
			type: "session",
			version: version === 1 ? undefined : version,
			id,
			timestamp: "2026-11-03T00:00:00.000Z",
			cwd,
		});
	}

	function expectRejectedSwitchUnchanged(
		file: string,
		options: { expectedSessionId: string; expectedCwd: string },
		error: RegExp,
	): void {
		const currentFile = join(tempDir, "current.jsonl");
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "persist current session" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} satisfies AssistantMessage;
		writeFileSync(currentFile, [
			sessionHeader("session-current", tempDir),
			JSON.stringify({
				type: "message",
				id: "current-assistant",
				parentId: null,
				timestamp: "2026-11-03T00:00:01.000Z",
				message: assistantMessage,
			}),
		].join("\n") + "\n");
		const current = SessionManager.openExisting(currentFile, {
			expectedSessionId: "session-current",
			expectedCwd: tempDir,
		});
		current.addExternalUsage("child", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 });
		const snapshot = () => ({
			file: current.getSessionFile(),
			id: current.getSessionId(),
			cwd: current.getCwd(),
			header: current.getHeader(),
			entries: current.getEntries(),
			leafId: current.getLeafId(),
			branch: current.getBranch(),
			usage: current.getUsageTotals({ includeExternalUsage: true }),
		});
		const before = snapshot();
		const original = readFileSync(currentFile, "utf8");

		expect(() => current.setSessionFile(file, options)).toThrow(error);
		expect(snapshot()).toEqual(before);
		expect(readFileSync(currentFile, "utf8")).toBe(original);

		// The same reporter must remain valid after validation rejects a session switch.
		const usageBeforeReport = current.getUsageTotals({ includeExternalUsage: true });
		current.addExternalUsage("child", { input: 14, output: 7, cacheRead: 2, cacheWrite: 0, cost: 0.2 });
		const usageAfterReport = current.getUsageTotals({ includeExternalUsage: true });
		expect(usageAfterReport).toEqual({
			input: usageBeforeReport.input + 4,
			output: usageBeforeReport.output + 2,
			cacheRead: usageBeforeReport.cacheRead + 2,
			cacheWrite: usageBeforeReport.cacheWrite,
			cost: usageBeforeReport.cost + 0.1,
		});

		// A later write must still target the original session, not the rejected file.
		current.appendMessage({ role: "user", content: "after rejected switch", timestamp: 3 });
		expect(loadEntriesFromFile(currentFile).at(-1)).toMatchObject({
			type: "message", message: { role: "user", content: "after rejected switch" },
		});
		expect(() => SessionManager.openExisting(currentFile, {
			expectedSessionId: "session-current",
			expectedCwd: tempDir,
		})).not.toThrow();
	}

	it("opens the exact existing file only when identity and cwd match", () => {
		const file = join(tempDir, "chosen session.jsonl");
		const otherFile = join(tempDir, "other session.jsonl");
		const id = "session-chosen";
		writeFileSync(file, `${sessionHeader(id, tempDir)}\n`);
		writeFileSync(otherFile, `${sessionHeader("session-other", tempDir)}\n`);

		const session = SessionManager.openExisting(file, {
			expectedSessionId: id,
			expectedCwd: tempDir,
		});

		expect(session.getSessionFile()).toBe(file);
		expect(session.getSessionId()).toBe(id);
		expect(session.getCwd()).toBe(tempDir);
	});

	it.each([2, CURRENT_SESSION_VERSION])("rejects duplicate IDs and parent cycles in v%i before migration", (version) => {
		const cases: Array<[string, Array<[string, string | null]>, RegExp]> = [
			["self-cycle", [["a", "a"], ["leaf", null]], /parent cycle/],
			["multi-entry-cycle", [["a", "b"], ["b", "c"], ["c", "a"], ["leaf", null]], /parent cycle/],
			["duplicate-id", [["a", null], ["a", null]], /duplicate entry ID/],
		];
		for (const [name, links, error] of cases) {
			const file = join(tempDir, `${name}-v${version}.jsonl`);
			const sessionDir = join(tempDir, `${name}-sessions`);
			const options = { expectedSessionId: "session-chosen", expectedCwd: tempDir };
			const original = [
				sessionHeader(options.expectedSessionId, tempDir, version),
				...links.map(([id, parentId]) => JSON.stringify({
					type: "custom", id, parentId, timestamp: "2026-11-03T00:00:00.000Z", customType: "fixture",
				})),
			].join("\n");
			writeFileSync(file, original);

			expect(() => SessionManager.openExisting(file, { ...options, sessionDir })).toThrow(error);
			expectRejectedSwitchUnchanged(file, options, error);
			expect(existsSync(sessionDir)).toBe(false);
			expect(readFileSync(file, "utf8")).toBe(original);
		}
	});

	it("accepts forward parent references and branches sharing an ancestor", () => {
		const file = join(tempDir, "forward-parents.jsonl");
		const links: Array<[string, string | null]> = [["left", "root"], ["root", null], ["right", "root"]];
		const original = [
			sessionHeader("session-chosen", tempDir),
			...links.map(([id, parentId]) => JSON.stringify({
				type: "custom", id, parentId, timestamp: "2026-11-03T00:00:00.000Z", customType: "fixture",
			})),
		].join("\n");
		writeFileSync(file, original);

		const session = SessionManager.openExisting(file, {
			expectedSessionId: "session-chosen", expectedCwd: tempDir,
		});
		expect(session.getBranch("left").map((entry) => entry.id)).toEqual(["root", "left"]);
		expect(session.getBranch().map((entry) => entry.id)).toEqual(["root", "right"]);
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it.each([1, 2, CURRENT_SESSION_VERSION])("opens native bashExecution messages and preserves v%i migration", (version) => {
		for (const exitCode of [0, undefined]) {
			const file = join(tempDir, `bash-v${version}-${exitCode ?? "cancelled"}.jsonl`);
			const bashMessage = {
				role: "bashExecution",
				command: "printf hello",
				output: "hello",
				exitCode,
				cancelled: exitCode === undefined,
				truncated: true,
				fullOutputPath: join(tempDir, "bash-output.txt"),
				excludeFromContext: true,
				timestamp: 2,
			} satisfies BashExecutionMessage;
			const noteMessage = {
				role: version < 3 ? "hookMessage" : "custom",
				customType: "fixture", content: "note", display: true, timestamp: 1,
			};
			writeFileSync(file, [
				sessionHeader("session-chosen", tempDir, version),
				JSON.stringify({
					type: "message", timestamp: "2026-11-03T00:00:00.000Z", message: noteMessage,
					...(version >= 2 ? { id: "note", parentId: null } : {}),
				}),
				JSON.stringify({
					type: "message", timestamp: "2026-11-03T00:00:01.000Z", message: bashMessage,
					...(version >= 2 ? { id: "bash", parentId: "note" } : {}),
				}),
			].join("\n"));

			const session = SessionManager.openExisting(file, {
				expectedSessionId: "session-chosen", expectedCwd: tempDir,
			});
			const branch = session.getBranch();
			expect(session.getSessionFile()).toBe(file);
			expect(session.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
			expect(branch.map((entry) => entry.type === "message" ? entry.message : undefined)).toEqual([
				{ ...noteMessage, role: "custom" }, bashMessage,
			]);
			expect(branch[0].id).toBeTruthy();
			expect(branch[0].parentId).toBeNull();
			expect(branch[1].id).toBeTruthy();
			expect(branch[1].id).not.toBe(branch[0].id);
			expect(branch[1].parentId).toBe(branch[0].id);
			if (version >= 2) expect(branch.map((entry) => entry.id)).toEqual(["note", "bash"]);
			expect(loadEntriesFromFile(file)).toEqual([session.getHeader(), ...session.getEntries()]);
		}
	});

	it("does not create or rewrite missing or corrupt session files", () => {
		const legacyHeader = JSON.stringify({
			type: "session", id: "session-chosen", cwd: tempDir, timestamp: "2026-11-03T00:00:00.000Z",
		});
		const cases: Array<[string, string | undefined]> = [
			["missing", undefined],
			["empty", ""],
			["invalid-header", JSON.stringify({ type: "message", id: "orphan" })],
			["malformed-entry", `${sessionHeader("session-chosen", tempDir)}\n{invalid json}`],
			["unknown-entry", `${legacyHeader}\n${JSON.stringify({ type: "future_entry", id: "entry", parentId: null, timestamp: "2026-11-03T00:00:00.000Z" })}`],
			["corrupt-message", `${legacyHeader}\n${JSON.stringify({
				type: "message", id: "entry", parentId: null, timestamp: "2026-11-03T00:00:00.000Z",
			})}`],
			["corrupt-message-content", `${legacyHeader}\n${JSON.stringify({
				type: "message", id: "entry", parentId: null, timestamp: "2026-11-03T00:00:00.000Z",
				message: { role: "user", content: null },
			})}`],
			["corrupt-bash-message", `${legacyHeader}\n${JSON.stringify({
				type: "message", timestamp: "2026-11-03T00:00:00.000Z",
				message: { role: "bashExecution", content: "not a native bash message" },
			})}`],
			["corrupt-bash-exit-code", `${legacyHeader}\n${JSON.stringify({
				type: "message", timestamp: "2026-11-03T00:00:00.000Z",
				message: {
					role: "bashExecution", command: "printf hello", output: "hello", exitCode: null,
					cancelled: true, truncated: false, timestamp: 1,
				},
			})}`],
			["future-version", JSON.stringify({
				type: "session", version: CURRENT_SESSION_VERSION + 1, id: "session-chosen",
				cwd: tempDir, timestamp: "2026-11-03T00:00:00.000Z",
			})],
		];

		for (const [name, original] of cases) {
			const file = join(tempDir, `${name}.jsonl`);
			const sessionDir = join(tempDir, `${name}-sessions`);
			if (original !== undefined) writeFileSync(file, original);

			expect(() => SessionManager.openExisting(file, {
				expectedSessionId: "session-chosen",
				expectedCwd: tempDir,
				sessionDir,
			})).toThrow(/Cannot resume exact GSD session/);
			expectRejectedSwitchUnchanged(file, {
				expectedSessionId: "session-chosen", expectedCwd: tempDir,
			}, /Cannot resume exact GSD session/);
			expect(existsSync(sessionDir)).toBe(false);
			if (original === undefined) {
				expect(existsSync(file)).toBe(false);
			} else {
				expect(readFileSync(file, "utf8")).toBe(original);
			}
		}
	});

	it("rejects a replaced identity or mismatched cwd without rewriting the file", () => {
		const file = join(tempDir, "replaced.jsonl");
		const original = `${sessionHeader("session-other", tempDir)}\n`;
		writeFileSync(file, original);

		expect(() => SessionManager.openExisting(file, {
			expectedSessionId: "session-chosen",
			expectedCwd: tempDir,
		})).toThrow(/session identity did not match/);
		expect(() => SessionManager.openExisting(file, {
			expectedSessionId: "session-other",
			expectedCwd: join(tempDir, "elsewhere"),
		})).toThrow(/working directory did not match/);
		expectRejectedSwitchUnchanged(file, {
			expectedSessionId: "session-chosen", expectedCwd: tempDir,
		}, /session identity did not match/);
		expectRejectedSwitchUnchanged(file, {
			expectedSessionId: "session-other", expectedCwd: join(tempDir, "elsewhere"),
		}, /working directory did not match/);
		expect(readFileSync(file, "utf8")).toBe(original);
	});
});
