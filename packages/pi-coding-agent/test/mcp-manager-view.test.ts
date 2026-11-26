import { setKeybindings, type TUI } from "@gsd/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { McpManagerView } from "../src/extensions/mcp/ui.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ESCAPE = "\x1b";
const tui = { requestRender: vi.fn() } as unknown as TUI;

function rendered(view: McpManagerView): string {
	return stripAnsi(view.render(80).join("\n"));
}

describe("MCP manager status screen", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// #10565
	test("cancels the running operation with the cancel key", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const onCancel = vi.fn();
		view.status("Sign in to issues", "Contacting the authorization server…", onCancel);
		expect(rendered(view)).toContain("cancel");
		view.handleInput(ESCAPE);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	test("ignores the cancel key for operations that cannot be cancelled", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.status("Sign in to issues", "Connecting…");
		expect(rendered(view)).not.toContain("cancel");
		view.handleInput(ESCAPE);
	});
});

describe("MCP manager menu", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	// #7629
	test("captures fullscreen viewport keys only while a menu list is shown", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const items = Array.from({ length: 20 }, (_, index) => ({ value: `server-${index}`, label: `server-${index}` }));
		const result = view.menu(() => ({ title: "MCP servers", items, confirmLabel: "open", cancelLabel: "close" }));
		expect(view.capturesViewportInput).toBe(true);

		view.handleInput("\x1b[6~"); // PageDown
		view.handleInput("\r");
		await expect(result).resolves.toBe("server-12");

		view.status("Sign in to issues", "Connecting…");
		expect(view.capturesViewportInput).toBe(false);
	});
});
