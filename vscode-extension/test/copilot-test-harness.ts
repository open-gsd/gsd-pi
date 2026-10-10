// Executes the built CommonJS classes, replacing only VS Code and the child process.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

export function makeToken() {
	let cancelled = false;
	const callbacks = new Set<() => void>();
	return {
		get isCancellationRequested() { return cancelled; },
		onCancellationRequested(callback: () => void) { callbacks.add(callback); return { dispose() { callbacks.delete(callback); } }; },
		cancel() { cancelled = true; for (const callback of callbacks) callback(); },
	};
}

export class ControlledProcess extends EventEmitter {
	exitCode: number | null = null;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	commands: Array<Record<string, any>> = [];
	stdin = { write: (line: string) => { this.commands.push(JSON.parse(line)); return true; } };
	kill() { queueMicrotask(() => this.exit()); return true; }
	exit(code = 0, signal = "SIGTERM") { this.exitCode = code; this.emit("exit", code, signal); }
	respond(command: Record<string, any>, data: unknown, extra: Record<string, unknown> = {}) {
		this.stdout.emit("data", Buffer.from(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data, ...extra }) + "\n"));
	}
	lastCommand() { return this.commands.at(-1)!; }
}

export function createHarness() {
	const processes: ControlledProcess[] = [];
	const textParts: string[] = [];
	const results: unknown[] = [];
	const registeredTools: Array<{ name: string; tool: any }> = [];
	const vscode = {
		MarkdownString: class { value: string; constructor(value: string) { this.value = value; } },
		lm: { registerTool(name: string, tool: any) { registeredTools.push({ name, tool }); return { dispose() {} }; } },
		workspace: { workspaceFolders: [{ uri: { fsPath: "/project" } }] },
		EventEmitter: class {
			listeners = new Set<(value: unknown) => void>();
			event = (callback: (value: unknown) => void) => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
			fire(value: unknown) { for (const listener of this.listeners) listener(value); }
			dispose() { this.listeners.clear(); }
		},
		LanguageModelTextPart: class { value: string; constructor(value: string) { this.value = value; textParts.push(value); } },
		LanguageModelToolResult: class { content: unknown[]; constructor(content: unknown[]) { this.content = content; results.push(this); } },
		window: {
			showQuickPick: async () => undefined as unknown,
			showInformationMessage: async () => undefined as unknown,
			showInputBox: async () => undefined as unknown,
			showErrorMessage: () => undefined,
			showWarningMessage: () => undefined,
		},
	};
	const realRequire = createRequire(import.meta.url);
	const cache = new Map<string, { exports: any }>();
	function load(filename: string): any {
		if (cache.has(filename)) return cache.get(filename)!.exports;
		const module = { exports: {} as any };
		cache.set(filename, module);
		const controlledRequire = (id: string) => {
			if (id === "vscode") return vscode;
			if (id === "node:child_process") return { spawn() {
				const proc = new ControlledProcess(); processes.push(proc);
				queueMicrotask(() => proc.emit("spawn")); return proc;
			} };
			if (id.startsWith(".")) return load(resolve(dirname(filename), id));
			return realRequire(id);
		};
		const execute = runInNewContext(`(function(require,module,exports){${readFileSync(filename, "utf8")}\n})`, { Buffer, process, setTimeout, clearTimeout }, { filename });
		execute(controlledRequire, module, module.exports);
		return module.exports;
	}
	const dist = fileURLToPath(new URL("../dist/", import.meta.url));
	const { GsdClient } = load(resolve(dist, "gsd-client.js"));
	const { ProjectProgressTool, ProjectSnapshotTool, registerCopilotTools } = load(resolve(dist, "copilot-tools.js"));
	const client = new GsdClient("controlled-gsd", "/project");
	return { client, ProjectProgressTool, ProjectSnapshotTool, processes, textParts, results, vscode, registeredTools, registerCopilotTools };
}
