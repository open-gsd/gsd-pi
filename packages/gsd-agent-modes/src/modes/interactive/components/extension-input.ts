// gsd-pi + packages/pi-coding-agent/src/modes/interactive/components/extension-input.ts - Extension text input dialog.
/**
 * Simple text input component for extensions.
 */

import { type Focusable, getEditorKeybindings, Input, Spacer, Text, type TUI } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { DialogContainer, splitDialogTitle } from "./dialog-container.js";
import { keyHint } from "./keybinding-hints.js";

export interface ExtensionInputOptions {
	tui?: TUI;
	timeout?: number;
	secure?: boolean;
}

export class ExtensionInputComponent extends DialogContainer implements Focusable {
	private input: Input;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		title: string,
		placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: ExtensionInputOptions,
	) {
		const dialogTitle = splitDialogTitle(title);
		super(dialogTitle.title);

		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.baseTitle = dialogTitle.title;

		this.addChild(new Spacer(1));
		for (const detail of dialogTitle.detailLines) {
			this.addChild(new Text(theme.fg("text", detail), 1, 0));
		}
		if (dialogTitle.detailLines.length > 0) {
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.setDialogTitle(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.input = new Input();
		this.input.secure = opts?.secure === true;
		if (placeholder) {
			this.input.setPlaceholder(placeholder);
		}
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyHint("selectConfirm", "submit")}  ${keyHint("selectCancel", "cancel")}`, 1, 0));
		this.addChild(new Spacer(1));
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectConfirm")) {
			if (this.input.getValue().trim() === "") return;
			this.onSubmitCallback(this.input.getValue());
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		} else {
			this.input.handleInput(keyData);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
