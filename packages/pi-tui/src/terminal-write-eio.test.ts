import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "./components/text.ts";
import { isStdoutClosedError, ProcessTerminal } from "./terminal.ts";
import type { Terminal } from "./terminal.ts";
import { TUI } from "./tui.ts";

describe("isStdoutClosedError", () => {
	it("recognizes write EIO and other pipe-closed errors", () => {
		assert.equal(
			isStdoutClosedError(Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" })),
			true,
		);
		assert.equal(isStdoutClosedError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
		assert.equal(isStdoutClosedError(new Error("write EOF")), true);
		assert.equal(
			isStdoutClosedError(Object.assign(new Error("open EIO"), { code: "EIO", syscall: "open" })),
			false,
		);
	});
});

describe("ProcessTerminal write EIO handling", () => {
	it("swallows write EIO and notifies the output-closed handler once", () => {
		const previousWrite = process.stdout.write;
		let handlerCalls = 0;
		const terminal = new ProcessTerminal();
		terminal.setOutputClosedHandler(() => {
			handlerCalls += 1;
		});

		try {
			process.stdout.write = (() => {
				throw Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" });
			}) as typeof process.stdout.write;

			assert.doesNotThrow(() => terminal.write("frame"));
			assert.equal(handlerCalls, 1);
			assert.equal(terminal.outputClosed, true);

			assert.doesNotThrow(() => terminal.write("frame"));
			assert.equal(handlerCalls, 1);
		} finally {
			process.stdout.write = previousWrite;
		}
	});
});

class BrokenWriteTerminal implements Terminal {
	readonly isTTY = true;
	readonly kittyProtocolActive = false;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(_data: string): void {
		throw Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" });
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class StartupClosedTerminal implements Terminal {
	readonly isTTY = true;
	readonly kittyProtocolActive = false;
	outputClosed = false;

	setOutputClosedHandler(handler: () => void): void {
		this.outputClosed = true;
		handler();
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}

	stop(): void {}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(_data: string): void {}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

describe("TUI render loop on dead stdout", () => {
	it("stops rendering and notifies onOutputClosed instead of throwing", async () => {
		let closed = false;
		const terminal = new BrokenWriteTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new Text("hello"));
		tui.onOutputClosed = () => {
			closed = true;
		};

		tui.start();
		tui.requestRender(true);

		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		assert.equal(closed, true);
		tui.stop();
	});

	it("notifies onOutputClosed when assigned after startup output closes", () => {
		let closed = false;
		const terminal = new StartupClosedTerminal();
		const tui = new TUI(terminal);

		tui.start();
		tui.onOutputClosed = () => {
			closed = true;
		};

		assert.equal(closed, true);
		tui.stop();
	});
});
