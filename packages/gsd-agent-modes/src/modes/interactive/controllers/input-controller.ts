import type { ImageContent } from "@gsd/pi-ai";
import { Text } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { dispatchSlashCommand } from "../slash-command-handlers.js";
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";
import type { ContextualTips } from "@gsd/agent-core";
import * as modeInit from "../interactive-mode-init.js";

/**
 * Consume and clear any pending pasted images from the host.
 * Returns undefined if there are no pending images.
 */
function consumePendingImages(host: InteractiveModeStateHost): ImageContent[] | undefined {
	if (host.pendingImages.length === 0) return undefined;
	const images = [...host.pendingImages];
	host.pendingImages.length = 0;
	return images;
}

function markEditorSubmitLatency(host: InteractiveModeStateHost, images: ImageContent[] | undefined): void {
	host.session.beginTurnLatency?.({ source: "tui", trigger: "editor_submit" });
	host.session.markTurnLatency?.("tui.editor_submit", { images: images?.length ?? 0 });
}

function wireEditorSubmitHandler(
	host: InteractiveModeStateHost & { editor: { onSubmit?: (text: string) => void | Promise<void> } },
	handler: (text: string) => Promise<void>,
): void {
	host.defaultEditor.onSubmit = handler;
	if (host.editor !== host.defaultEditor) {
		host.editor.onSubmit = handler;
	}
}

export function setupEditorSubmitHandler(host: InteractiveModeStateHost & {
	getSlashCommandContext: () => any;
	handleBashCommand: (command: string, excludeFromContext?: boolean) => Promise<void>;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showTip: (message: string) => void;
	updateEditorBorderColor: () => void;
	isExtensionCommand: (text: string) => boolean;
	isKnownSlashCommand: (text: string) => boolean;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp") => void;
	updatePendingMessagesDisplay: () => void;
	flushPendingBashComponents: () => void;
	contextualTips: ContextualTips;
	getContextPercent: () => number | undefined;
	options?: { submitPromptsDirectly?: boolean };
}): void {
	const onSubmit = async (text: string) => {
		text = text.trim();
		if (!text) return;

		if (!host.session.isStreaming) {
			host.clearBlockingError();
		}

		modeInit.dismissStartupHeader(host as Parameters<typeof modeInit.dismissStartupHeader>[0]);

		if (text.startsWith("/") && !looksLikeFilePath(text)) {
			const handled = await dispatchSlashCommand(text, host.getSlashCommandContext());
			if (handled) {
				host.editor.setText("");
				consumePendingImages(host); // discard images on slash command
				return;
			}
			if (!host.isKnownSlashCommand(text)) {
				const command = text.split(/\s/)[0];
				host.showError(`Unknown command: ${command}. Use slash autocomplete to see available commands.`);
				host.editor.setText("");
				return;
			}
		}

		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (host.session.isBashRunning) {
					host.showWarning("A bash command is already running. Press Esc to cancel it first.");
					host.editor.setText(text);
					return;
				}
				// Track included bash commands for double-bang tip
				if (!isExcluded) {
					host.contextualTips.recordBashIncluded();
				}
				host.editor.addToHistory?.(text);
				await host.handleBashCommand(command, isExcluded);
				host.isBashMode = false;
				host.updateEditorBorderColor();
				consumePendingImages(host); // discard images on bash command
				return;
			}
		}

		// Evaluate contextual tips before sending to agent
		const tip = host.contextualTips.evaluate({
			input: text,
			isStreaming: host.session.isStreaming,
			thinkingLevel: host.session.thinkingLevel,
			contextPercent: host.getContextPercent(),
		});
		if (tip) {
			host.showTip(tip);
		}

		if (host.onInputCallback) {
			host.onInputCallback(text);
			host.editor.addToHistory?.(text);
			return;
		}

		// Consume pending images for prompt submissions
		const images = consumePendingImages(host);

		if (host.session.isCompacting) {
			if (host.isExtensionCommand(text)) {
				host.editor.addToHistory?.(text);
				host.editor.setText("");
				try {
					await host.session.prompt(text, { images });
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					host.showError(errorMessage);
				}
			} else {
				host.queueCompactionMessage(text, "steer");
			}
			return;
		}

		if (host.session.isStreaming) {
			host.editor.addToHistory?.(text);
			host.editor.setText("");
			await host.session.prompt(text, { streamingBehavior: "steer", images });
			host.updatePendingMessagesDisplay();
			host.ui.requestRender();
			return;
		}

		host.flushPendingBashComponents();

		if (host.options?.submitPromptsDirectly) {
			host.editor.addToHistory?.(text);
			try {
				markEditorSubmitLatency(host, images);
				await host.session.prompt(text, { images });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				host.showError(errorMessage);
			}
			return;
		}

		host.editor.addToHistory?.(text);
		// submitPromptsDirectly is false; still dispatch via session.prompt so user input
		// is not silently discarded.
		try {
			markEditorSubmitLatency(host, images);
			await host.session.prompt(text, { images });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			host.showError(errorMessage);
		}
	};

	const onSubmitWithCommandFeedback = async (text: string) => {
		const command = text.trim();
		if (!command.startsWith("/") || looksLikeFilePath(command) || !host.isExtensionCommand(command)) {
			return onSubmit(text);
		}
		const clearPending = await showExtensionCommandPending(host, command);
		try {
			await onSubmit(text);
		} finally {
			clearPending();
		}
	};

	wireEditorSubmitHandler(host, onSubmitWithCommandFeedback);
}

/** Longer than the TUI's 16 ms render throttle, so the frame requested first paints first. */
const EXTENSION_COMMAND_PAINT_DELAY_MS = 20;

/**
 * Extension command handlers may open with synchronous work (`/gsd auto` and
 * `/gsd next` start with git and database calls), and nothing can paint while
 * they hold the event loop: the screen keeps showing the typed command as if
 * Enter had been ignored (#2598). Show that the command was accepted and let
 * that frame reach the terminal before the handler runs.
 *
 * Returns a function that removes the line again.
 */
async function showExtensionCommandPending(host: InteractiveModeStateHost, command: string): Promise<() => void> {
	const name = command.split(/\s+/).slice(0, 2).join(" ");
	const pending = new Text(theme.fg("dim", `Running ${name}…`), 1, 0);
	host.statusContainer.addChild(pending);
	host.ui.requestRender();
	await new Promise<void>((resolve) => setTimeout(resolve, EXTENSION_COMMAND_PAINT_DELAY_MS));
	return () => {
		host.statusContainer.removeChild(pending);
		host.ui.requestRender();
	};
}

/**
 * Distinguish absolute file paths from slash commands (#3478).
 * Drag-and-drop inserts paths like "/Users/name/Desktop/file.png" which
 * should be treated as plain text input, not a /Users command.
 *
 * Heuristic: a slash command is a single token like "/help" or "/gsd auto".
 * File paths have a second "/" within the first token (e.g., "/Users/...").
 */
function looksLikeFilePath(text: string): boolean {
	const firstToken = text.split(/\s/)[0];
	// Slash commands: /help, /gsd, /commit — single "/" at start only.
	// File paths: /Users/name/file, /home/user/file, /tmp/x — contain "/" after position 0.
	return firstToken.indexOf("/", 1) !== -1;
}
