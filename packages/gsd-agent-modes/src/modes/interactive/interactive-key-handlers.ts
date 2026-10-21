// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@gsd/pi-ai";
import { listDescendants } from "@gsd/native";
import { spawnSync } from "child_process";
import { readClipboardImage } from "@gsd/pi-coding-agent/utils/clipboard-image.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";
import { MIME_BY_EXT, matchesImageSignature } from "./interactive-mode-class-constants.js";

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export function setupKeyHandlers(host: InteractiveModeDelegateHost): void {
		// Set up handlers on defaultEditor - they use host.editor for text access
		// so they work correctly regardless of which editor is active
		host.defaultEditor.onEscape = () => {
			if (host.loadingAnimation) {
				host.restoreQueuedMessagesToEditor({ abort: true });
			} else if (host.session.isBashRunning) {
				host.session.abortBash();
			} else if (host.isBashMode) {
				host.editor.setText("");
				host.pendingImages.length = 0;
				host.isBashMode = false;
				host.updateEditorBorderColor();
			} else if (!host.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = host.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - host.lastEscapeTime < 500) {
						if (action === "tree") {
							host.showTreeSelector();
						} else {
							host.showUserMessageSelector();
						}
						host.lastEscapeTime = 0;
					} else {
						host.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		host.defaultEditor.onAction("clear", () => handleCtrlC(host, ));
		host.defaultEditor.onCtrlD = () => handleCtrlD(host, );
		host.defaultEditor.onAction("suspend", () => host.handleCtrlZ());
		host.defaultEditor.onAction("cycleThinkingLevel", () => host.cycleThinkingLevel());
		host.defaultEditor.onAction("cycleModelForward", () => host.cycleModel("forward"));
		host.defaultEditor.onAction("cycleModelBackward", () => host.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		host.ui.onDebug = () => host.handleDebugCommand();
		host.defaultEditor.onAction("selectModel", () => host.showModelSelector());
		host.defaultEditor.onAction("expandTools", () => host.toggleToolOutputExpansion());
		host.defaultEditor.onToggleGsdStatus = () => host.toggleGsdStatusWidget?.();
		host.defaultEditor.onAction("toggleThinking", () => host.toggleThinkingBlockVisibility());
		host.defaultEditor.onAction("externalEditor", () => host.openExternalEditor());
		host.defaultEditor.onAction("followUp", () => host.handleFollowUp());
		host.defaultEditor.onAction("dequeue", () => host.handleDequeue());
		host.defaultEditor.onAction("newSession", () => host.handleClearCommand());
		host.defaultEditor.onAction("tree", () => host.showTreeSelector());
		host.defaultEditor.onAction("fork", () => host.showUserMessageSelector());
		host.defaultEditor.onAction("resume", () => host.showSessionSelector());

		host.defaultEditor.onChange = (text: string) => {
			const wasBashMode = host.isBashMode;
			host.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== host.isBashMode) {
				host.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		host.defaultEditor.onPasteImage = () => {
			host.handleClipboardImagePaste();
		};

		// Handle image file paths pasted via terminal emulator (e.g. iTerm2).
		// Set on defaultEditor here; setCustomEditorComponent guards re-assignment for custom editors.
		host.defaultEditor.onPasteImagePath = (filePath: string) => {
			host.handlePastedImagePath(filePath);
		};
	}

export async function handleClipboardImagePaste(host: InteractiveModeDelegateHost): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Store image as base64 ImageContent for sending with the prompt
			const imageContent: ImageContent = {
				type: "image",
				data: Buffer.from(image.bytes).toString("base64"),
				mimeType: image.mimeType,
			};
			host.pendingImages.push(imageContent);

			// Insert friendly placeholder instead of file path
			const imageNum = host.pendingImages.length;
			host.editor.insertTextAtCursor?.(`[Image #${imageNum}]`);
			host.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

export function handlePastedImagePath(host: InteractiveModeDelegateHost, filePath: string): void {
		try {
			const ext = path.extname(filePath).slice(1).toLowerCase();
			const mimeType = MIME_BY_EXT[ext];
			if (!mimeType) {
				// Unsupported / unsafe extension — fall back to inserting raw path.
				host.editor.insertTextAtCursor?.(filePath);
				host.ui.requestRender();
				return;
			}

			// Reject symlinks to prevent reading sensitive files via a symlinked
			// `.png` that points at e.g. ~/.ssh/id_rsa.
			const lst = fs.lstatSync(filePath);
			if (!lst.isFile()) {
				host.editor.insertTextAtCursor?.(filePath);
				host.ui.requestRender();
				return;
			}

			const data = fs.readFileSync(filePath);

			// Magic-byte check — confirms file content actually matches the
			// extension before we forward bytes to a model.
			if (!matchesImageSignature(data, mimeType)) {
				host.editor.insertTextAtCursor?.(filePath);
				host.ui.requestRender();
				return;
			}

			host.pendingImages.push({
				type: "image",
				data: data.toString("base64"),
				mimeType,
			});

			const imageNum = host.pendingImages.length;
			host.editor.insertTextAtCursor?.(`[Image #${imageNum}]`);
			host.ui.requestRender();
		} catch {
			// Fall back to inserting the raw path if file can't be read
			host.editor.insertTextAtCursor?.(filePath);
			host.ui.requestRender();
		}
	}

export function handleCtrlC(host: InteractiveModeDelegateHost): void {
		const now = Date.now();
		if (now - host.lastSigintTime < 500) {
			void host.shutdown();
		} else {
			host.clearEditor();
			host.lastSigintTime = now;
		}
	}

export function handleCtrlD(host: InteractiveModeDelegateHost): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void host.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */

export async function shutdown(host: InteractiveModeDelegateHost): Promise<void> {
		const shutdownBehavior = host.options.shutdownBehavior ?? "exit_process";
		if (shutdownBehavior === "ignore") {
			host.showStatus("Quit is unavailable in the browser-attached terminal");
			return;
		}

		if (host.isShuttingDown) return;
		host.isShuttingDown = true;

		// Flush any queued settings writes before shutdown
		await host.settingsManager.flush();

		// Emit shutdown event to extensions
		const extensionRunner = host.session.extensionRunner;
		if (extensionRunner?.hasHandlers("session_shutdown")) {
			await extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await host.ui.terminal.drainInput(1000);

		host.stop();
		if (shutdownBehavior === "stop_ui") {
			return;
		}

		// Kill ALL descendant processes to prevent orphans (next-server, pnpm dev, etc.)
		try {
			const descendants = listDescendants(process.pid);
			for (const childPid of descendants) {
				try { process.kill(childPid, "SIGTERM"); } catch {}
			}
			if (descendants.length > 0) {
				await new Promise(resolve => setTimeout(resolve, 500));
				for (const childPid of descendants) {
					try { process.kill(childPid, "SIGKILL"); } catch {}
				}
			}
		} catch {}

		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
export async function checkShutdownRequested(host: InteractiveModeDelegateHost): Promise<void> {
		if (!host.shutdownRequested) return;
		await host.shutdown();
	}

export function handleCtrlZ(host: InteractiveModeDelegateHost): void {
		// On Windows, SIGTSTP doesn't exist - Ctrl+Z is not supported
		if (process.platform === "win32") {
			return;
		}

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		try {
			// Set up handler to restore TUI when resumed
			process.once("SIGCONT", () => {
				process.removeListener("SIGINT", ignoreSigint);
				host.ui.start();
				host.ui.requestRender(true);
			});

			// Stop the TUI (restore terminal to normal mode)
			host.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch {
			// If suspend fails (e.g. SIGTSTP not supported), ensure the
			// SIGINT listener doesn't leak.
			process.removeListener("SIGINT", ignoreSigint);
		}
	}

export async function handleFollowUp(host: InteractiveModeDelegateHost): Promise<void> {
		const text = (host.editor.getExpandedText?.() ?? host.editor.getText()).trim();
		if (!text) return;

		if (text.startsWith("/") && !host.isKnownSlashCommand(text)) {
			const command = text.split(/\s/)[0];
			host.showError(`Unknown command: ${command}. Use slash autocomplete to see available commands.`);
			return;
		}

		// Consume pending images
		const images = host.pendingImages.length > 0 ? [...host.pendingImages] : undefined;
		host.pendingImages.length = 0;

		// Queue input during compaction (extension commands execute immediately)
		if (host.session.isCompacting) {
			if (host.isExtensionCommand(text)) {
				host.editor.addToHistory?.(text);
				host.editor.setText("");
				await host.session.prompt(text, { images });
			} else {
				host.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (host.session.isStreaming) {
			host.editor.addToHistory?.(text);
			host.editor.setText("");
			await host.session.prompt(text, { streamingBehavior: "followUp", images });
			host.updatePendingMessagesDisplay();
			host.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (host.editor.onSubmit) {
			host.editor.onSubmit(text);
		}
	}

export function handleDequeue(host: InteractiveModeDelegateHost): void {
		const restored = host.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			host.showStatus("No queued messages to restore");
		} else {
			host.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

export function updateEditorBorderColor(host: InteractiveModeDelegateHost): void {
		if (host.isBashMode) {
			host.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = host.session.thinkingLevel || "off";
			host.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		host.ui.requestRender();
	}

export function cycleThinkingLevel(host: InteractiveModeDelegateHost): void {
		const newLevel = host.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			host.showStatus("Current model does not support thinking");
		} else {
			host.footer.invalidate();
			host.updateEditorBorderColor();
			host.showStatus(`Thinking level: ${newLevel}`);
		}
	}

export async function cycleModel(host: InteractiveModeDelegateHost, direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await host.session.cycleModel(direction);
			if (result === undefined) {
				const msg = host.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				host.showStatus(msg);
			} else {
				host.footer.invalidate();
				host.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				host.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			host.showError(error instanceof Error ? error.message : String(error));
		}
	}

export function toggleToolOutputExpansion(host: InteractiveModeDelegateHost): void {
		host.setToolsExpanded(!host.toolOutputExpanded);
	}

export function setToolsExpanded(host: InteractiveModeDelegateHost, expanded: boolean): void {
		host.toolOutputExpanded = expanded;
		for (const child of host.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		host.ui.requestRender();
	}

export function toggleThinkingBlockVisibility(host: InteractiveModeDelegateHost): void {
		host.hideThinkingBlock = !host.hideThinkingBlock;
		host.settingsManager.setHideThinkingBlock(host.hideThinkingBlock);

		// Disable shrink debounce during rebuild to prevent full redraw flash.
		// The clear() + rebuildChatFromMessages() changes content length, which
		// would trigger the TUI's _shrinkDebounceActive path and cause a
		// full repaint (~1.5s cadence) that jumps the viewport.
		const prevClearOnShrink = host.ui.getClearOnShrink();
		host.ui.setClearOnShrink(false);

		try {
			// Rebuild chat from session messages
			host.chatContainer.clear();
			host.rebuildChatFromMessages();

			// If streaming, re-add the streaming component with updated visibility
			if (host.streamingComponent && host.streamingMessage) {
				host.streamingComponent.setHideThinkingBlock(host.hideThinkingBlock);
				host.streamingComponent.updateContent(host.streamingMessage);
				host.chatContainer.addChild(host.streamingComponent);
			}
		} finally {
			// Always restore the previous clearOnShrink value, even if
			// rebuildChatFromMessages() throws — otherwise the TUI is left
			// with shrink-clearing permanently disabled.
			host.ui.setClearOnShrink(prevClearOnShrink);
		}

		host.showStatus(`Thinking blocks: ${host.hideThinkingBlock ? "hidden" : "visible"}`);
	}

export function openExternalEditor(host: InteractiveModeDelegateHost): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			let msg = "No editor configured. Set $VISUAL or $EDITOR environment variable.";
			if (process.env.TERM_PROGRAM === "iTerm.app") {
				msg +=
					"\n\nTip: If you meant to open the GSD dashboard (Ctrl+Alt+G), set Left Option Key to" +
					" \"Esc+\" in iTerm2 → Profiles → Keys. With the default \"Normal\" setting," +
					" Ctrl+Alt+G sends Ctrl+G instead.";
			}
			host.showWarning(msg);
			return;
		}

		const currentText = host.editor.getExpandedText?.() ?? host.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			host.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				host.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			host.ui.start();
			// Force full re-render since external editor uses alternate screen
			host.ui.requestRender(true);
		}
	}
