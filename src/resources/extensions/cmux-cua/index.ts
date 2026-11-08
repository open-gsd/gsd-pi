import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { StringEnum, Type } from "@gsd/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	assertDesktopDriverProcessAllowed,
	captureDesktopProcessIdentity,
	desktopOwnershipManager,
	DesktopOwnershipError,
	isDesktopProcessIdentityAlive,
	isDesktopProcessIdentityExited,
	type DesktopOwnershipLease,
	type DesktopOwnershipManager,
	type DesktopProcessIdentity,
	type DesktopTerminalEvidence,
} from "../shared/desktop-ownership.js";

const SERVER_NAME = "cmux-cua";
const SERVER_VERSION = "0.7.1";
const SERVER_TOOL_COUNT = 39;
const PINNED_SOURCE_COMMIT = "e0f738807dbff2f35fe67d7fbcc99c7082cffc23";
// No archived metadata hash is accepted as endpoint-authentication evidence.
// G-03 must establish the live endpoint binding before runtime admission opens.
const REQUIRED_NATIVE_TOOLS = [
	"check_permissions",
	"click",
	"end_session",
	"get_window_state",
	"list_apps",
	"list_windows",
	"start_session",
] as const;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_ELEMENTS = 200;
const MAX_TREE_DEPTH = 8;
const MAX_LABEL_CHARS = 256;
const MAX_VALUE_CHARS = 128;
const GRANT_TTL_MS = 10_000;
const MCP_CONNECT_TIMEOUT_MS = 5_000;
const MCP_CALL_TIMEOUT_MS = 15_000;
const CLEANUP_BUDGET_MS = 6_000;
// Keep runtime admission closed until G-03 proves endpoint authentication before
// capability transmission and backend quiescence. Never override this via env.
const G03_RUNTIME_ADMISSION_ENABLED = false;
const ALLOWED_CLICK_ROLES = new Set(["AXButton", "AXCheckBox", "AXRadioButton"]);

const cmuxCuaInspectParameters = Type.Object({}, { additionalProperties: false });
export const cmuxCuaActionParameters = Type.Object({
	grant_id: Type.String({ minLength: 1, maxLength: 128 }),
	target_id: Type.String({ minLength: 1, maxLength: 128 }),
	operation: StringEnum(["click"]),
	postcondition: Type.Object({
		kind: StringEnum(["ax-value-equals"]),
		observer_id: Type.String({ minLength: 1, maxLength: 128 }),
		expected: Type.String({ minLength: 1, maxLength: MAX_VALUE_CHARS }),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

interface JsonRecord {
	[key: string]: unknown;
}

interface NativeEnvelope {
	isError: boolean;
	structured: JsonRecord | null;
}

interface CmuxHandoff {
	homeDirectory: string;
	tempDirectory: string;
	runtimeScope: string;
	socketPath: string;
	socketDirectory: string;
	socketDevice: number;
	socketInode: number;
	tokenFilePath: string;
	stateDirectory: string;
	clientPath: string;
	hostBundleId: string;
	helperExecutable: string;
	daemonPid: number;
	daemonIdentity: DesktopProcessIdentity;
}

interface SelectedApp {
	pid: number;
	name: string;
	bundleId: string;
}

interface SelectedWindow {
	targetId: string;
	pid: number;
	windowId: number;
	appName: string;
	title: string;
}

interface BoundElement {
	targetId: string;
	pid: number;
	windowId: number;
	elementToken: string;
	role: string;
	label: string;
	identifier: string;
}

interface BoundObserver {
	observerId: string;
	pid: number;
	windowId: number;
	role: string;
	identifier: string;
	label: string;
	initialValue: string;
}

interface InspectionGrant {
	id: string;
	snapshotId: string;
	target: SelectedWindow;
	expiresAt: number;
	consumed: boolean;
	elements: Map<string, BoundElement>;
	observers: Map<string, BoundObserver>;
}

// Connected transactions require an explicit peer assertion; there is no unbound mode.
// Production binds this to the verified native handoff. Portable fixtures may only
// assert a synthetic protocol generation, not claim native peer authentication.
export interface ConnectedCuaSession {
	client: Client;
	ownershipManager: DesktopOwnershipManager;
	assertPeerBound: () => void;
	lease: DesktopOwnershipLease;
	target: SelectedWindow | null;
	grant: InspectionGrant | null;
	axTextSharingApproved: boolean;
	hadAction: boolean;
}

interface ActiveCuaSession extends ConnectedCuaSession {
	transport: StdioClientTransport;
	proxyIdentity: DesktopProcessIdentity | null;
	sessionId: string | null;
	sessionBase: string;
	handoff: CmuxHandoff;
	started: boolean;
	startAttempted: boolean;
	stopping: boolean;
	lost: boolean;
}

let activeSession: ActiveCuaSession | null = null;
let sessionTransition: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeText(value: unknown, maximum: number): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) return false;
	if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
	if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)) return false;
	if (/\b(?:password|passcode|secret|access token|api key|private key|credential)\b/iu.test(value)) return false;
	return !/\b(?:\d[ -]*?){13,19}\b/u.test(value);
}

export function validateNativeToolInventory(serverName: unknown, serverVersion: unknown, tools: readonly unknown[]): void {
	if (serverName !== SERVER_NAME || serverVersion !== SERVER_VERSION || tools.length !== SERVER_TOOL_COUNT) {
		throw new Error(`cmux CUA server identity/version does not match pinned source ${PINNED_SOURCE_COMMIT}`);
	}
	const names = new Set<string>();
	for (const tool of tools) {
		if (!isRecord(tool) || typeof tool.name !== "string" || typeof tool.description !== "string" || !isRecord(tool.inputSchema) || (tool.annotations !== undefined && !isRecord(tool.annotations)) || names.has(tool.name)) {
			throw new Error("native CUA tool inventory is malformed");
		}
		names.add(tool.name);
	}
	for (const name of REQUIRED_NATIVE_TOOLS) {
		if (!names.has(name)) throw new Error("pinned native CUA tool is missing");
	}
}

function parseMcpEnvelope(value: unknown): NativeEnvelope {
	if (!isRecord(value) || !Array.isArray(value.content)) throw new Error("native CUA response is not a valid MCP result");
	let textBytes = 0;
	for (const item of value.content) {
		if (!isRecord(item) || item.type === "image") throw new Error("native CUA returned an unapproved image");
		if (item.type === "text" && typeof item.text === "string") {
			textBytes += Buffer.byteLength(item.text, "utf8");
			if (textBytes > MAX_RESULT_BYTES) throw new Error("native CUA text result exceeds the approved bound");
		}
	}
	return { isError: value.isError === true, structured: isRecord(value.structuredContent) ? value.structuredContent : null };
}

function requireStructuredResult(envelope: NativeEnvelope): JsonRecord {
	if (envelope.isError || !envelope.structured) throw new Error("native CUA tool did not return valid structured content");
	return envelope.structured;
}

export function decodeStartSessionResult(envelope: NativeEnvelope, expectedPrefix: string): string {
	const result = requireStructuredResult(envelope);
	if (!exactKeys(result, ["session", "active", "revived"])) throw new Error("start_session result schema mismatch");
	if (typeof result.session !== "string" || !result.session.startsWith(expectedPrefix)) throw new Error("start_session identity does not match the managed proxy generation");
	const suffix = result.session.slice(expectedPrefix.length);
	if (!/^[A-Za-z0-9-]{1,64}$/.test(suffix)) throw new Error("start_session identity has an invalid invocation suffix");
	if (result.active !== true || result.revived !== false) throw new Error("start_session did not establish a fresh managed session");
	return result.session;
}

export function decodeEndSessionResult(envelope: NativeEnvelope, expectedSession: string): void {
	const result = requireStructuredResult(envelope);
	if (!exactKeys(result, ["session", "active"])) throw new Error("end_session result schema mismatch");
	if (result.session !== expectedSession || result.active !== false) throw new Error("end_session did not terminate the managed session");
}

export function decodeClickResult(envelope: NativeEnvelope): { effect: "unverifiable" | "suspected_noop" } {
	const result = requireStructuredResult(envelope);
	if (!exactKeys(result, ["path", "verified", "effect"]) && !exactKeys(result, ["path", "verified", "effect", "escalation"])) throw new Error("click result schema mismatch");
	if (result.path !== "ax" || result.verified !== false) throw new Error("click result is not the pinned background AX acknowledgment");
	if (result.effect !== "unverifiable" && result.effect !== "suspected_noop") throw new Error("click result effect is unknown");
	if (result.escalation !== undefined && !isRecord(result.escalation)) throw new Error("click escalation metadata is malformed");
	return { effect: result.effect };
}

function decodeHostPermissions(envelope: NativeEnvelope, hostBundleId: string): void {
	const result = requireStructuredResult(envelope);
	if (result.accessibility !== true || result.screen_recording !== true) throw new Error("cmux host accessibility and screen-recording permissions must both be granted");
	if (!isRecord(result.source) || result.source.attribution !== "host" || result.source.embedded !== true) throw new Error("permission report is not attributed to the embedded host");
	if (result.source.host_bundle_id !== hostBundleId) throw new Error("permission report host identity differs from the verified cmux app");
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key];
	if (!value || !path.isAbsolute(value)) throw new Error(`cmux CUA handoff field ${key} is missing or invalid`);
	return value;
}

function requiredManagedSessionBase(env: NodeJS.ProcessEnv): string {
	const value = env.CMUX_CUA_DEFAULT_SESSION;
	if (!value || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
		throw new Error("managed cmux CUA default session is missing or invalid");
	}
	return value;
}

function checkOwnedDirectoryTree(root: string, target: string, uid: number, requirePrivate: boolean): string {
	const safeRoot = realpathSync(root);
	const resolvedTarget = path.resolve(target);
	const relative = path.relative(safeRoot, resolvedTarget);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("cmux CUA runtime path escapes its approved root");
	let current = safeRoot;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		const entry = lstatSync(current);
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o022) !== 0) {
			throw new Error("cmux CUA runtime directory ownership or permissions are invalid");
		}
	}
	const final = lstatSync(resolvedTarget);
	if (requirePrivate && (final.mode & 0o077) !== 0) throw new Error("cmux CUA runtime directory is not owner-only");
	return resolvedTarget;
}

function codeSignature(bundlePath: string, expectedIdentifier?: string): { identifier: string; team: string } {
	const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundlePath], {
		encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
	});
	if (verify.status !== 0) throw new Error("cmux CUA code-signature verification failed");
	const detail = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", bundlePath], {
		encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
	});
	if (detail.status !== 0) throw new Error("cmux CUA code-signature identity is unavailable");
	const output = `${detail.stdout ?? ""}\n${detail.stderr ?? ""}`;
	const identifier = /^Identifier=(.+)$/m.exec(output)?.[1];
	const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
	if (!identifier || !team || team === "not set" || (expectedIdentifier && identifier !== expectedIdentifier)) throw new Error("cmux CUA code-signature identity is not trusted");
	return { identifier, team };
}

function appBundleForExecutable(executablePath: string): string {
	let current = path.dirname(executablePath);
	while (current !== path.dirname(current)) {
		if (path.basename(current).endsWith(".app")) return current;
		current = path.dirname(current);
	}
	throw new Error("cmux CUA client is not inside a signed app bundle");
}

function readPrivateSmallFile(filePath: string, uid: number, maxBytes: number): string {
	if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("no-follow file open is unavailable");
	const descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	try {
		const opened = fstatSync(descriptor);
		const named = lstatSync(filePath);
		if (!opened.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino ||
			opened.uid !== uid || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 || opened.size > maxBytes) {
			throw new Error("cmux CUA private file ownership, mode, or size is invalid");
		}
		const buffer = Buffer.alloc(maxBytes + 1);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		if (bytesRead <= 0 || bytesRead > maxBytes) throw new Error("cmux CUA private file is empty or oversized");
		const after = lstatSync(filePath);
		if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("cmux CUA private file changed during validation");
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}

function processCommandMatches(pid: number, expectedExecutable: string): boolean {
	const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf8", timeout: 1_000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 && (result.stdout ?? "").trim().startsWith(expectedExecutable);
}

function verifyHostHandoff(env: NodeJS.ProcessEnv): CmuxHandoff {
	if (process.platform !== "darwin" || typeof process.getuid !== "function") throw new Error("cmux CUA is supported only on macOS");
	const uid = process.getuid();
	const home = realpathSync(userInfo().homedir);
	const scope = env.CMUX_CUA_RUNTIME_SCOPE;
	if (!scope || scope.length > 128 || !/^[A-Za-z0-9._-]+$/.test(scope) || scope === "." || scope === "..") throw new Error("cmux CUA runtime scope is invalid");
	const socketPath = requiredEnv(env, "CMUX_CUA_SOCKET_PATH");
	const tokenFilePath = requiredEnv(env, "CMUX_CUA_AUTH_TOKEN_FILE");
	const stateDirectory = requiredEnv(env, "CMUX_CUA_STATE_DIR");
	const clientPath = requiredEnv(env, "CMUX_CUA_CLIENT_PATH");
	const tempDirectory = realpathSync(tmpdir());
	const socketParent = path.join(tempDirectory, `cmux-cua-${uid}`, scope);
	const socketDirectory = checkOwnedDirectoryTree(tempDirectory, socketParent, uid, true);
	const expectedSocket = path.join(socketDirectory, "cmux-cua.sock");
	if (path.resolve(socketPath) !== expectedSocket) throw new Error("cmux CUA socket path is outside the inherited runtime scope");
	const socketStat = lstatSync(expectedSocket);
	if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== uid || (socketStat.mode & 0o777) !== 0o600) throw new Error("cmux CUA socket ownership or mode is invalid");
	const expectedTokenFile = path.join(socketDirectory, "auth-token");
	if (path.resolve(tokenFilePath) !== expectedTokenFile) throw new Error("cmux CUA capability path is outside the inherited runtime scope");
	const stateDirectoryExpected = path.join(home, "Library", "Application Support", "cmux", "cmux-cua", "runtime", scope, "state");
	if (path.resolve(stateDirectory) !== stateDirectoryExpected) throw new Error("cmux CUA state directory is outside the OS-account runtime scope");
	checkOwnedDirectoryTree(home, stateDirectoryExpected, uid, true);
	const helperDirectory = path.join(home, "Library", "Application Support", "cmux", "cmux-cua", "helper", scope);
	checkOwnedDirectoryTree(home, helperDirectory, uid, true);
	const helperBundle = path.join(helperDirectory, "cmux Computer Use.app");
	const helperIdentity = codeSignature(helperBundle, "com.cmuxterm.cua");
	const helperExecutable = realpathSync(path.join(helperBundle, "Contents", "MacOS", "cmux-cua"));
	const helperStat = lstatSync(helperExecutable);
	if (!helperStat.isFile() || helperStat.isSymbolicLink() || (helperStat.mode & 0o111) === 0) throw new Error("cmux CUA helper executable is invalid");
	const realClientPath = realpathSync(clientPath);
	if (path.basename(realClientPath) !== "cmux-cua" || !realClientPath.includes(`${path.sep}Contents${path.sep}Resources${path.sep}bin${path.sep}`)) throw new Error("cmux CUA client executable is not the bundled proxy");
	const hostBundlePath = appBundleForExecutable(realClientPath);
	if (path.basename(hostBundlePath) !== "cmux.app") throw new Error("cmux CUA client bundle is not cmux.app");
	const hostIdentity = codeSignature(hostBundlePath);
	if (!hostIdentity.identifier.startsWith("com.cmuxterm.") || helperIdentity.team !== hostIdentity.team) throw new Error("cmux CUA client and helper are not signed by the same cmux team");
	const pidFile = `${expectedSocket.slice(0, -".sock".length)}.pid`;
	const pidText = readPrivateSmallFile(pidFile, uid, 64).trim();
	if (!/^\d{1,10}$/.test(pidText)) throw new Error("cmux CUA daemon PID file is malformed");
	const daemonPid = Number(pidText);
	const daemonIdentity = captureDesktopProcessIdentity(daemonPid);
	if (!daemonIdentity || !processCommandMatches(daemonPid, helperExecutable)) throw new Error("cmux CUA daemon peer identity is not bound to the signed helper generation");
	return {
		homeDirectory: home, tempDirectory, runtimeScope: scope, socketPath: expectedSocket,
		socketDirectory, socketDevice: socketStat.dev, socketInode: socketStat.ino,
		tokenFilePath: expectedTokenFile, stateDirectory: stateDirectoryExpected,
		clientPath: realClientPath, hostBundleId: hostIdentity.identifier,
		helperExecutable, daemonPid, daemonIdentity,
	};
}

function assertPeerStillBound(handoff: CmuxHandoff): void {
	const socket = lstatSync(handoff.socketPath);
	if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid?.() || socket.dev !== handoff.socketDevice || socket.ino !== handoff.socketInode) throw new Error("cmux CUA socket binding changed");
	const pidText = readPrivateSmallFile(`${handoff.socketPath.slice(0, -".sock".length)}.pid`, process.getuid?.() ?? -1, 64).trim();
	if (pidText !== String(handoff.daemonPid) || !isDesktopProcessIdentityAlive(handoff.daemonIdentity) || !processCommandMatches(handoff.daemonPid, handoff.helperExecutable)) throw new Error("cmux CUA daemon peer generation changed");
}

function readCapabilityToken(filePath: string): string {
	const token = readPrivateSmallFile(filePath, process.getuid?.() ?? -1, 4_096);
	const normalized = token.endsWith("\n") ? token.slice(0, -1) : token;
	if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error("cmux CUA capability token format is invalid");
	return normalized;
}

function buildProxyEnvironment(handoff: CmuxHandoff, token: string, sessionBase: string): Record<string, string> {
	return {
		HOME: handoff.homeDirectory, TMPDIR: handoff.tempDirectory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		LANG: "en_US.UTF-8", LC_ALL: "C",
		CMUX_CUA_SOCKET_PATH: handoff.socketPath, CMUX_CUA_SOCKET_AUTH_TOKEN: token,
		CMUX_CUA_DEFAULT_SESSION: sessionBase, CMUX_CUA_RUNTIME_SCOPE: handoff.runtimeScope,
		CMUX_CUA_STATE_DIR: handoff.stateDirectory, CMUX_CUA_STATE_OWNER_PID: String(process.pid),
		CMUX_CUA_MCP_FORCE_PROXY: "1", CMUX_CUA_EXTERNAL_PERMISSION_FLOW: "1",
		CMUX_CUA_TELEMETRY_ENABLED: "false", CMUX_CUA_UPDATE_CHECK: "false",
		CMUX_BUNDLE_ID: handoff.hostBundleId,
	};
}

function decodeApps(value: unknown): SelectedApp[] {
	const result = parseMcpEnvelope(value);
	if (result.isError || !result.structured || !Array.isArray(result.structured.apps) || result.structured.apps.length > 1_000) throw new Error("list_apps result schema mismatch");
	const apps: SelectedApp[] = [];
	for (const item of result.structured.apps) {
		if (isRecord(item) && typeof item.pid === "number" && Number.isInteger(item.pid) && item.pid > 0 && item.running === true && safeText(item.name, 128) && safeText(item.bundle_id, 256)) apps.push({ pid: item.pid, name: item.name, bundleId: item.bundle_id });
	}
	return apps.slice(0, 100);
}

export function formatAppOption(app: SelectedApp): string {
	return `PID ${app.pid}: ${app.name} (${app.bundleId})`;
}

function decodeWindowsForPid(pid: number): (value: unknown) => Array<{ windowId: number; appName: string; title: string }> {
	return (value) => {
		const result = parseMcpEnvelope(value);
		if (result.isError || !result.structured || !Array.isArray(result.structured.windows) || result.structured.windows.length > 1_000) throw new Error("list_windows result schema mismatch");
		return result.structured.windows.filter((item): item is JsonRecord =>
			isRecord(item) && item.pid === pid && item.is_on_screen === true && typeof item.window_id === "number" && Number.isInteger(item.window_id) && item.window_id > 0 && safeText(item.app_name, 128) && (item.title === null || item.title === undefined || safeText(item.title, 256)),
		).slice(0, 50).map((item) => ({ windowId: item.window_id as number, appName: item.app_name as string, title: typeof item.title === "string" ? item.title : item.app_name as string }));
	};
}

function decodeWindowState(value: unknown, target: SelectedWindow): JsonRecord {
	const result = parseMcpEnvelope(value);
	if (result.isError || !result.structured) throw new Error("get_window_state did not return structured content");
	const state = result.structured;
	if (state.pid !== target.pid || state.window_id !== target.windowId || typeof state.snapshot_id !== "string" || !state.snapshot_id || typeof state.tree_markdown !== "string") throw new Error("window snapshot identity or tree is invalid");
	if (typeof state.element_count !== "number" || !Number.isInteger(state.element_count) || state.element_count < 0 || state.element_count > MAX_ELEMENTS || !Array.isArray(state.elements) || state.elements.length > MAX_ELEMENTS || state.degraded === true) throw new Error("window snapshot is incomplete or degraded");
	if (["screenshot", "screenshot_base64", "screenshot_file_path", "image"].some((key) => key in state)) throw new Error("window snapshot includes unapproved screenshot data");
	if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_RESULT_BYTES) throw new Error("window snapshot exceeds the approved data bound");
	return state;
}

export function decodePostClickWindowState(value: unknown, target: SelectedWindow): JsonRecord {
	return decodeWindowState(value, target);
}

function mapTreeIdentifiers(tree: string): Map<number, string> {
	const identifiers = new Map<number, string>();
	for (const line of tree.split("\n")) {
		const index = /^\s*-\s+\[(\d+)\]\s+/.exec(line)?.[1];
		if (!index) continue;
		const metadata = /\[([^\]]*)\]\s*$/.exec(line)?.[1];
		const identifier = metadata ? /(?:^|\s)id=([A-Za-z0-9._:-]{1,128})(?:\s|$)/.exec(metadata)?.[1] : undefined;
		if (identifier) identifiers.set(Number(index), identifier);
	}
	return identifiers;
}

function safeValue(value: unknown, role: string, label: string): value is string {
	if (!safeText(value, MAX_VALUE_CHARS) || /secure|password|textfield|textarea/iu.test(role)) return false;
	if (/password|passcode|secret|token|credential|customer|account number/iu.test(label)) return false;
	return true;
}

function sanitizeLabel(value: unknown): string | null {
	return safeText(value, MAX_LABEL_CHARS) ? value : null;
}

export function buildSnapshotBindings(snapshot: JsonRecord, target: SelectedWindow) {
	const identifiers = mapTreeIdentifiers(snapshot.tree_markdown as string);
	const elements = new Map<string, BoundElement>();
	const observers = new Map<string, BoundObserver>();
	const publicElements: Array<{ target_id: string; role: string; label: string | null }> = [];
	const publicObservers: Array<{ observer_id: string; role: string; label: string; current_value: string }> = [];
	const selectorCounts = new Map<string, number>();
	for (const item of snapshot.elements as unknown[]) {
		if (!isRecord(item) || typeof item.role !== "string" || typeof item.element_index !== "number") continue;
		const identifier = identifiers.get(item.element_index);
		if (!identifier) continue;
		const selectorKey = JSON.stringify([item.role, identifier]);
		selectorCounts.set(selectorKey, (selectorCounts.get(selectorKey) ?? 0) + 1);
	}
	for (const item of snapshot.elements as unknown[]) {
		if (!isRecord(item) || typeof item.role !== "string" || /secure|password|textfield|textarea/iu.test(item.role)) continue;
		const label = sanitizeLabel(item.label);
		if (label === null) continue;
		const index = typeof item.element_index === "number" && Number.isInteger(item.element_index) ? item.element_index : null;
		const identifier = index === null ? undefined : identifiers.get(index);
		let observerId: string | undefined;
		if (
			identifier
			&& selectorCounts.get(JSON.stringify([item.role, identifier])) === 1
			&& typeof item.value === "string"
			&& safeValue(item.value, item.role, label)
		) {
			observerId = randomUUID();
			observers.set(observerId, { observerId, pid: target.pid, windowId: target.windowId, role: item.role, identifier, label, initialValue: item.value });
			publicObservers.push({ observer_id: observerId, role: item.role, label, current_value: item.value });
		}
		if (typeof item.element_token === "string" && item.element_token.length > 0 && ALLOWED_CLICK_ROLES.has(item.role)) {
			const targetId = randomUUID();
			elements.set(targetId, { targetId, pid: target.pid, windowId: target.windowId, elementToken: item.element_token, role: item.role, label, identifier: identifier ?? "" });
			publicElements.push({ target_id: targetId, role: item.role, label });
		}
	}
	return { elements, observers, publicElements, publicObservers };
}

function verifyObserver(snapshot: JsonRecord, observer: BoundObserver, expected: string): boolean {
	const identifiers = mapTreeIdentifiers(snapshot.tree_markdown as string);
	const matches = (snapshot.elements as unknown[]).filter((item) => isRecord(item) && item.role === observer.role && typeof item.element_index === "number" && identifiers.get(item.element_index) === observer.identifier);
	if (matches.length !== 1) return false;
	const match = matches[0];
	return isRecord(match) && safeValue(match.value, observer.role, observer.label) && match.value === expected && match.value !== observer.initialValue;
}

function safeDisplayTitle(value: string): string {
	return safeText(value, MAX_LABEL_CHARS) ? value : "[redacted]";
}

async function requestConsent(ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		"Enable cmux Computer Use?",
		"This grants one interactive GSD session permission to inspect one selected app window and issue a single click at a time. Clicks can change application state. Screenshots, text entry, coordinate actions, and automatic retries are disabled. The session ends when this GSD session shuts down or switches context.",
		{ signal, timeout: 30_000 },
	);
}

export async function approveAxTextSharing(
	session: { axTextSharingApproved: boolean },
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<boolean> {
	if (session.axTextSharingApproved) return true;
	if (!ctx.hasUI) return false;
	const approved = await ctx.ui.confirm(
		"Share Accessibility Text with the Model?",
		"Accessibility labels and visible text from the selected app window will be returned to the selected model and saved in this Pi session's conversation history. This is separate from permission to drive the app. Approve sharing for this session?",
		{ signal, timeout: 30_000 },
	);
	if (approved) session.axTextSharingApproved = true;
	return approved;
}

export function beginInspection(session: { grant: unknown; hadAction: boolean }): void {
	session.grant = null;
	if (session.hadAction) throw new Error("this session has dispatched a click; G-03 backend-quiescence proof is required before further native access");
}

async function listAllTools(client: Client, signal?: AbortSignal): Promise<unknown[]> {
	const tools: unknown[] = [];
	let cursor: string | undefined;
	for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
		const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: MCP_CALL_TIMEOUT_MS });
		if (!Array.isArray(page.tools)) throw new Error("cmux CUA tools/list result is malformed");
		tools.push(...page.tools);
		if (!page.nextCursor) return tools;
		if (page.nextCursor === cursor) throw new Error("cmux CUA tools/list cursor repeated");
		cursor = page.nextCursor;
	}
	throw new Error("cmux CUA tools/list pagination exceeded the limit");
}

export async function discoverNativeContract(client: Client, signal?: AbortSignal): Promise<void> {
	const server = client.getServerVersion();
	const tools = await listAllTools(client, signal);
	validateNativeToolInventory(server?.name, server?.version, tools);
}

async function runNativeRead<T>(session: ConnectedCuaSession, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, decode: (value: unknown) => T): Promise<T> {
	const operationId = session.ownershipManager.beginOperation(session.lease, "inspect");
	let terminal = false;
	try {
		session.assertPeerBound();
		const raw = await session.client.callTool({ name, arguments: args }, undefined, { signal, timeout: MCP_CALL_TIMEOUT_MS });
		const decoded = decode(raw);
		session.ownershipManager.completeOperation(session.lease, operationId);
		terminal = true;
		return decoded;
	} catch (error) {
		if (!terminal) {
			try { session.ownershipManager.quarantine(session.lease, operationId, "dispatch-uncertain"); } catch { /* journal remains fail-closed */ }
		}
		throw error;
	}
}

async function startCuaSession(ctx: ExtensionContext, signal?: AbortSignal): Promise<ActiveCuaSession> {
	assertDesktopDriverProcessAllowed(process.env, process.argv, ctx.isLocalInteractiveDesktop);
	if (!ctx.isLocalInteractiveDesktop || !ctx.hasUI || !(await requestConsent(ctx, signal))) {
		throw new Error("explicit local interactive driving consent was not granted");
	}
	const sessionBase = requiredManagedSessionBase(process.env);
	const handoff = verifyHostHandoff(process.env);
	const token = readCapabilityToken(handoff.tokenFilePath);
	const client = new Client({ name: "gsd-cmux-cua", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: handoff.clientPath,
		args: ["mcp", "--socket", handoff.socketPath],
		cwd: path.dirname(handoff.clientPath),
		env: buildProxyEnvironment(handoff, token, sessionBase),
		stderr: "ignore",
		maxBufferSize: 1_048_576,
	});
	const lease = desktopOwnershipManager.acquire("cmux-cua", "session", randomUUID());
	const session: ActiveCuaSession = {
		client, transport, lease, proxyIdentity: null, sessionId: null, sessionBase, handoff,
		ownershipManager: desktopOwnershipManager,
		assertPeerBound: () => assertPeerStillBound(handoff),
		target: null, grant: null, axTextSharingApproved: false, started: false, startAttempted: false, hadAction: false, stopping: false, lost: false,
	};
	activeSession = session;
	transport.onclose = () => {
		if (!session.stopping) {
			session.lost = true;
			try { desktopOwnershipManager.quarantine(session.lease, null, "cleanup-failed"); } catch { /* durable journal remains fail-closed */ }
		}
	};
	try {
		await client.connect(transport, { signal, timeout: MCP_CONNECT_TIMEOUT_MS });
		const proxyPid = transport.pid;
		if (!proxyPid) throw new Error("cmux CUA proxy process identity is unavailable");
		const proxyIdentity = captureDesktopProcessIdentity(proxyPid);
		if (!proxyIdentity) throw new Error("cmux CUA proxy process identity is not stable");
		session.proxyIdentity = proxyIdentity;
		assertPeerStillBound(handoff);
		await discoverNativeContract(client, signal);
		await runNativeRead(session, "check_permissions", { prompt: false }, signal, (value) => {
			decodeHostPermissions(parseMcpEnvelope(value), handoff.hostBundleId);
		});
		const startId = desktopOwnershipManager.beginOperation(lease, "session-start");
		session.startAttempted = true;
		try {
			assertPeerStillBound(handoff);
			const raw = await client.callTool({ name: "start_session", arguments: {} }, undefined, { signal, timeout: MCP_CALL_TIMEOUT_MS });
			assertPeerStillBound(handoff);
			const expectedPrefix = `${sessionBase}-mcp-${proxyPid}-`;
			session.sessionId = decodeStartSessionResult(parseMcpEnvelope(raw), expectedPrefix);
			session.started = true;
			desktopOwnershipManager.completeOperation(lease, startId);
			return session;
		} catch (error) {
			try { desktopOwnershipManager.quarantine(lease, startId, "dispatch-uncertain"); } catch { /* durable journal remains fail-closed */ }
			throw error;
		}
	} catch (error) {
		if (activeSession === session) activeSession = null;
		if (session.startAttempted) {
			await closeClient(session);
			try { desktopOwnershipManager.quarantine(lease, null, "cleanup-failed"); } catch { /* unresolved journal remains */ }
		} else {
			await releaseUnstartedSession(session);
		}
		throw error;
	}
}

async function selectTarget(session: ConnectedCuaSession, ctx: ExtensionContext, signal?: AbortSignal): Promise<SelectedWindow> {
	const apps = await runNativeRead(session, "list_apps", {}, signal, decodeApps);
	if (!ctx.isLocalInteractiveDesktop || !ctx.hasUI || apps.length === 0) {
		throw new Error("local interactive app selection is unavailable");
	}
	const appOptions = apps.map(formatAppOption);
	const selectedAppLabel = await ctx.ui.select("Choose one running app for cmux Computer Use", appOptions);
	if (typeof selectedAppLabel !== "string" || !selectedAppLabel) throw new Error("cmux CUA target selection was cancelled");
	const app = apps[appOptions.indexOf(selectedAppLabel)];
	if (!app) throw new Error("selected app is not in the current app snapshot");
	const windows = await runNativeRead(session, "list_windows", { pid: app.pid, on_screen_only: true }, signal, decodeWindowsForPid(app.pid));
	if (windows.length === 0) throw new Error("selected app has no visible windows");
	const windowOptions = windows.map((window) => `${window.title || window.appName} [${window.windowId}]`);
	const selectedWindowLabel = await ctx.ui.select("Choose one visible window", windowOptions);
	if (typeof selectedWindowLabel !== "string" || !selectedWindowLabel) throw new Error("cmux CUA window selection was cancelled");
	const window = windows[windowOptions.indexOf(selectedWindowLabel)];
	if (!window) throw new Error("selected window is not in the current window snapshot");
	return { ...window, targetId: randomUUID(), pid: app.pid };
}

export async function inspect(session: ConnectedCuaSession, ctx: ExtensionContext, signal?: AbortSignal) {
	beginInspection(session);
	const target = session.target ?? await selectTarget(session, ctx, signal);
	if (!(await approveAxTextSharing(session, ctx, signal))) throw new Error("separate AX-text sharing consent was not granted");
	const snapshot = await runNativeRead(session, "get_window_state", { pid: target.pid, window_id: target.windowId, capture_mode: "ax", include_screenshot: false, max_elements: MAX_ELEMENTS, max_depth: MAX_TREE_DEPTH }, signal, (value) => decodeWindowState(value, target));
	const bindings = buildSnapshotBindings(snapshot, target);
	if (bindings.elements.size === 0 || bindings.observers.size === 0) throw new Error("selected window has no uniquely identifiable safe click target with a verifiable postcondition");
	const grant: InspectionGrant = { id: randomUUID(), snapshotId: snapshot.snapshot_id as string, target, expiresAt: Date.now() + GRANT_TTL_MS, consumed: false, elements: bindings.elements, observers: bindings.observers };
	session.target = target;
	session.grant = grant;
	const output = { status: "ready", grant_id: grant.id, window: { app: safeDisplayTitle(target.appName), title: safeDisplayTitle(target.title) }, elements: bindings.publicElements, observers: bindings.publicObservers, expires_in_ms: GRANT_TTL_MS };
	if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_RESULT_BYTES) throw new Error("sanitized CUA inspection result exceeds the approved bound");
	return output;
}

export async function act(session: ConnectedCuaSession, params: JsonRecord, signal?: AbortSignal) {
	const grant = session.grant;
	if (session.hadAction) throw new Error("this session has already dispatched a click; G-03 backend-quiescence proof is required before another action");
	if (!grant || grant.consumed || Date.now() > grant.expiresAt || params.grant_id !== grant.id) {
		session.grant = null;
		throw new Error("grant is absent or expired; inspect again");
	}
	if (!exactKeys(params, ["grant_id", "target_id", "operation", "postcondition"]) || params.operation !== "click" || !isRecord(params.postcondition) || !exactKeys(params.postcondition, ["kind", "observer_id", "expected"])) {
		session.grant = null;
		throw new Error("action is outside the click-only contract");
	}
	const post = params.postcondition;
	if (post.kind !== "ax-value-equals" || typeof post.observer_id !== "string" || !safeText(post.expected, MAX_VALUE_CHARS)) {
		session.grant = null;
		throw new Error("postcondition is malformed or exceeds the safe text bound");
	}
	const target = grant.elements.get(String(params.target_id));
	const observer = grant.observers.get(post.observer_id);
	if (!target || !observer || target.pid !== grant.target.pid || target.windowId !== grant.target.windowId || observer.pid !== target.pid || observer.windowId !== target.windowId || observer.initialValue === post.expected) {
		session.grant = null;
		throw new Error("target or unique postcondition observer is stale or already satisfied");
	}
	grant.consumed = true;
	session.grant = null;
	const actionId = session.ownershipManager.beginOperation(session.lease, "action");
	let clickResult: ReturnType<typeof decodeClickResult>;
	try {
		session.assertPeerBound();
		session.hadAction = true;
		const raw = await session.client.callTool({ name: "click", arguments: { pid: target.pid, window_id: target.windowId, element_token: target.elementToken, action: "press", button: "left", count: 1, delivery_mode: "background" } }, undefined, { signal, timeout: MCP_CALL_TIMEOUT_MS });
		session.assertPeerBound();
		clickResult = decodeClickResult(parseMcpEnvelope(raw));
		session.ownershipManager.completeOperation(session.lease, actionId, { requiresVerification: true });
	} catch (error) {
		try { session.ownershipManager.quarantine(session.lease, actionId, "dispatch-uncertain"); } catch { /* unresolved journal remains */ }
		throw error;
	}
	const verificationId = session.ownershipManager.beginOperation(session.lease, "verify");
	try {
		session.assertPeerBound();
		const rawAfter = await session.client.callTool({ name: "get_window_state", arguments: { pid: target.pid, window_id: target.windowId, capture_mode: "ax", include_screenshot: false, max_elements: MAX_ELEMENTS, max_depth: MAX_TREE_DEPTH } }, undefined, { signal, timeout: MCP_CALL_TIMEOUT_MS });
		session.assertPeerBound();
		const after = decodePostClickWindowState(rawAfter, grant.target);
		const matched = verifyObserver(after, observer, post.expected) && clickResult.effect !== "suspected_noop";
		// An AX postcondition is not evidence that the backend has quiesced.
		// Persist quarantine even when the visible UI changed; never enable a retry.
		try {
			session.ownershipManager.completeVerification(session.lease, verificationId, false);
		} catch (error) {
			if (error instanceof DesktopOwnershipError && error.code === "quarantined") {
				return { status: "quarantined", ui_postcondition_met: matched, backend_quiescence: "unproven", target_id: target.targetId, observer_id: observer.observerId };
			}
			throw error;
		}
		throw new Error("desktop ownership manager did not quarantine the unproven backend operation");
	} catch (error) {
		try { session.ownershipManager.quarantine(session.lease, verificationId, "terminal-unverified"); } catch { /* unresolved journal remains */ }
		throw error;
	}
}

export interface ProxyCloseDependencies {
	currentPid: () => number | null;
	knownIdentity: DesktopProcessIdentity | null;
	captureIdentity?: (pid: number) => DesktopProcessIdentity | null;
	closeClient: () => Promise<void>;
	closeTransport: () => Promise<void>;
	isExited?: (identity: DesktopProcessIdentity) => boolean;
	budgetMs?: number;
}

export interface ProxyCloseResult {
	identity: DesktopProcessIdentity | null;
	exited: boolean;
}

function settledBeforeDeadline(promise: Promise<void>, deadline: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<boolean>((resolve) => {
		timeout = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
	});
	const settled = promise.then(() => true, () => true);
	return Promise.race([settled, timeoutPromise])
		.then((completed) => completed && Date.now() <= deadline)
		.finally(() => {
			if (timeout !== undefined) clearTimeout(timeout);
		});
}

export async function closeProxyAndVerifyExit(dependencies: ProxyCloseDependencies): Promise<ProxyCloseResult> {
	const configuredBudget = dependencies.budgetMs ?? CLEANUP_BUDGET_MS;
	const budgetMs = Number.isFinite(configuredBudget) ? Math.max(0, configuredBudget) : CLEANUP_BUDGET_MS;
	const deadline = Date.now() + budgetMs;
	let identity = dependencies.knownIdentity;
	if (!identity) {
		try {
			const pidBeforeClose = dependencies.currentPid();
			if (typeof pidBeforeClose === "number") identity = (dependencies.captureIdentity ?? captureDesktopProcessIdentity)(pidBeforeClose);
		} catch {
			// Close both handles, but absence of a captured identity must quarantine.
		}
	}
	const clientClose = Promise.resolve().then(() => dependencies.closeClient());
	const clientClosed = await settledBeforeDeadline(clientClose, deadline);
	const transportClose = Promise.resolve().then(() => dependencies.closeTransport());
	const transportClosed = await settledBeforeDeadline(transportClose, deadline);
	if (!clientClosed || !transportClosed || !identity || Date.now() >= deadline) return { identity, exited: false };

	const isExited = dependencies.isExited ?? isDesktopProcessIdentityExited;
	while (Date.now() < deadline) {
		let exited: boolean;
		try {
			exited = isExited(identity);
		} catch {
			return { identity, exited: false };
		}
		if (exited) return { identity, exited: Date.now() <= deadline };
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs)));
	}
	return { identity, exited: false };
}

export function settleDesktopClose(
	manager: Pick<typeof desktopOwnershipManager, "release" | "quarantine">,
	lease: DesktopOwnershipLease,
	evidence: DesktopTerminalEvidence | undefined,
	processExited: boolean,
	sessionLost: boolean,
	hadAction: boolean,
): "released" | "quarantined" {
	if (!evidence || !processExited || sessionLost || hadAction) {
		manager.quarantine(lease, null, hadAction ? "terminal-unverified" : "cleanup-failed");
		return "quarantined";
	}
	manager.release(lease, evidence);
	return "released";
}

async function closeClient(session: ActiveCuaSession): Promise<boolean> {
	session.stopping = true;
	session.grant = null;
	session.target = null;
	const result = await closeProxyAndVerifyExit({
		currentPid: () => session.transport.pid,
		knownIdentity: session.proxyIdentity,
		closeClient: () => session.client.close(),
		closeTransport: () => session.transport.close(),
	});
	session.proxyIdentity = result.identity;
	return result.exited;
}

async function releaseUnstartedSession(session: ActiveCuaSession): Promise<void> {
	const exited = await closeClient(session);
	if (!exited) {
		try { settleDesktopClose(desktopOwnershipManager, session.lease, undefined, false, session.lost, session.hadAction); } catch { /* journal remains */ }
		return;
	}
	try {
		const closeId = desktopOwnershipManager.beginOperation(session.lease, "connection-close");
		const evidence = desktopOwnershipManager.completeOperation(session.lease, closeId);
		settleDesktopClose(desktopOwnershipManager, session.lease, evidence, exited, session.lost, session.hadAction);
	} catch {
		try { desktopOwnershipManager.quarantine(session.lease, null, "cleanup-failed"); } catch { /* journal remains */ }
	}
}

export function revokeCuaSessionState(session: {
	stopping: boolean;
	grant: unknown;
	target: unknown;
	axTextSharingApproved: boolean;
}): void {
	session.stopping = true;
	session.grant = null;
	session.target = null;
	session.axTextSharingApproved = false;
}

async function stopSession(): Promise<void> {
	const session = activeSession;
	if (!session) return;
	activeSession = null;
	revokeCuaSessionState(session);
	let endEvidence: DesktopTerminalEvidence | undefined;
	if (session.started && session.sessionId && !session.lost) {
		try {
			assertPeerStillBound(session.handoff);
			const endId = desktopOwnershipManager.beginOperation(session.lease, "session-end");
			const raw = await session.client.callTool({ name: "end_session", arguments: { session: session.sessionId } }, undefined, { timeout: MCP_CALL_TIMEOUT_MS });
			decodeEndSessionResult(parseMcpEnvelope(raw), session.sessionId);
			endEvidence = desktopOwnershipManager.completeOperation(session.lease, endId);
		} catch {
			try { desktopOwnershipManager.quarantine(session.lease, null, "cleanup-failed"); } catch { /* journal remains */ }
		}
	}
	const exited = await closeClient(session);
	try {
		settleDesktopClose(desktopOwnershipManager, session.lease, endEvidence, exited, session.lost, session.hadAction);
	} catch {
		try { desktopOwnershipManager.quarantine(session.lease, null, "cleanup-failed"); } catch { /* journal remains */ }
	}
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = sessionTransition.then(fn, fn);
	sessionTransition = next.then(() => undefined, () => undefined);
	return next;
}

function toolResult(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, ...(isError ? { isError: true } : {}) };
}

function publicError(error: unknown) {
	const code = error instanceof DesktopOwnershipError ? error.code : "blocked";
	return toolResult({ status: "blocked", code, message: "cmux Computer Use failed closed; no automatic retry was made." }, true);
}

export function registerCuaSessionCleanup(pi: Pick<ExtensionAPI, "on">, cleanup: () => Promise<void>): void {
	const handleBoundary = async () => { await cleanup(); };
	pi.on("session_shutdown", handleBoundary);
	pi.on("session_before_tree", handleBoundary);
	pi.on("session_before_switch", handleBoundary);
	pi.on("session_before_fork", handleBoundary);
}

export default function (pi: ExtensionAPI): void {
	if (!G03_RUNTIME_ADMISSION_ENABLED) return;
	pi.registerTool({
		name: "cmux_cua_inspect",
		label: "Inspect One cmux Window",
		description: "After explicit interactive consent, select and inspect one cmux window. Returns bounded, sanitized accessibility labels and observer IDs; never returns native PIDs, window IDs, element tokens, or screenshots.",
		parameters: cmuxCuaInspectParameters,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			return serialize(async () => {
				try {
					assertDesktopDriverProcessAllowed(process.env, process.argv, ctx.isLocalInteractiveDesktop);
					if (!ctx.isLocalInteractiveDesktop || !ctx.hasUI) {
						throw new Error("cmux CUA requires a trusted local interactive session");
					}
					const session = activeSession ?? await startCuaSession(ctx, signal);
					return toolResult(await inspect(session, ctx, signal));
				} catch (error) {
					return publicError(error);
				}
			});
		},
	});
	pi.registerTool({
		name: "cmux_cua_action",
		label: "Click and Verify in cmux",
		description: "Perform one click on the previously inspected, approved target and verify its explicit AX-value postcondition. Click-only v1; text entry, coordinates, foreground fallback, retries, and raw native passthrough are unavailable.",
		parameters: cmuxCuaActionParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return serialize(async () => {
				try {
					assertDesktopDriverProcessAllowed(process.env, process.argv, ctx.isLocalInteractiveDesktop);
					if (!ctx.isLocalInteractiveDesktop || !ctx.hasUI) {
						throw new Error("cmux CUA requires a trusted local interactive session");
					}
					if (!activeSession || activeSession.lost || activeSession.stopping) throw new Error("inspect one window and obtain fresh consent before acting");
					return toolResult(await act(activeSession, params as unknown as JsonRecord, signal));
				} catch (error) {
					return publicError(error);
				}
			});
		},
	});
	registerCuaSessionCleanup(pi, async () => {
		await serialize(async () => { await stopSession(); return undefined; });
	});
}
