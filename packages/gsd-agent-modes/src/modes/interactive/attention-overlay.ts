/**
 * Native attention overlay controller (#2932, GSD-W086).
 *
 * Mutation-free by construction: the only injected effect is a read of an
 * already-verified same-project snapshot, and an optional `sendCommand` for
 * the existing read-only `/gsd blocker inspect <id>` route. The controller
 * never responds to a request, never resolves a blocker, never dispatches,
 * and never bootstraps or adopts a database. Keys that could mean approve,
 * retry, resolve, dismiss or recover are not bound.
 */
import { buildAttentionView, INSPECT_ONLY_NOTICE } from "./attention-model.js";
import type { AttentionItem, AttentionSource, AttentionView } from "./attention-model.js";

export interface AttentionSnapshot {
	/** null signals a failed read; it never binds or replaces the project identity. */
	projectKey: string | null;
	sources: AttentionSource[];
}

export interface AttentionReader {
	readSnapshot(): Promise<AttentionSnapshot>;
}

export interface AttentionControllerOptions {
	/** The only effect beyond reads: a read-only inspect route. */
	sendCommand?: (command: string) => boolean | void;
}

export interface AttentionState {
	open: boolean;
	detailsOpen: boolean;
	selected: number;
	/** First visible line of the details panel; reset whenever the selection changes. */
	detailScroll: number;
	status: "idle" | "ready" | "unavailable";
	items: AttentionItem[];
	coverage: AttentionView["coverage"];
	allClear: boolean;
	notice: string;
	announcements: string[];
	focusRestoreTarget: "previous-editor" | null;
}

export class AttentionOverlayController {
	private projectKey: string | null = null;
	private readonly seenIdentities = new Set<string>();
	private current: AttentionState = {
		open: false,
		detailsOpen: false,
		selected: 0,
		detailScroll: 0,
		status: "idle",
		items: [],
		coverage: [],
		allClear: false,
		notice: "",
		announcements: [],
		focusRestoreTarget: null,
	};
	private generation = 0;

	constructor(
		private readonly reader: AttentionReader,
		private readonly options: AttentionControllerOptions = {},
	) {}

	state(): AttentionState {
		return this.current;
	}

	async open(): Promise<void> {
		this.current = { ...this.current, open: true, detailsOpen: false, focusRestoreTarget: null };
		await this.refresh();
	}

	/**
	 * Re-read. Results from an earlier generation are discarded. A failed snapshot
	 * (projectKey null) shows unavailable status and never binds or replaces the
	 * project identity, so a later healthy snapshot still applies.
	 */
	async refresh(): Promise<void> {
		const generation = ++this.generation;
		let snapshot: AttentionSnapshot;
		try {
			snapshot = await this.reader.readSnapshot();
		} catch {
			snapshot = { projectKey: null, sources: [] };
		}
		if (generation !== this.generation) return;
		if (snapshot.projectKey === null) {
			// Keep per-namespace coverage so each unread source is visible with its reason.
			const coverage = buildAttentionView(snapshot.sources).coverage;
			this.showUnavailable("Attention status unavailable. Nothing was changed.", coverage);
			return;
		}
		if (this.projectKey === null) this.projectKey = snapshot.projectKey;
		if (snapshot.projectKey !== this.projectKey) {
			this.showUnavailable("Source conflict: project identity changed. Nothing was changed.");
			return;
		}
		this.apply(buildAttentionView(snapshot.sources));
	}

	private showUnavailable(notice: string, coverage: AttentionView["coverage"] = []): void {
		this.current = {
			...this.current,
			status: "unavailable",
			items: [],
			coverage,
			allClear: false,
			detailsOpen: false,
			notice,
		};
	}

	setProject(projectKey: string): void {
		if (this.projectKey !== null && this.projectKey !== projectKey) {
			this.generation++;
			this.seenIdentities.clear();
			this.current = { ...this.current, items: [], coverage: [], allClear: false, selected: 0, detailsOpen: false, detailScroll: 0 };
		}
		this.projectKey = projectKey;
	}

	private apply(view: AttentionView): void {
		const announcements = [...this.current.announcements];
		for (const item of view.items) {
			if (!this.seenIdentities.has(item.identity)) {
				this.seenIdentities.add(item.identity);
				announcements.push(item.identity);
			}
		}
		const selected = Math.min(this.current.selected, Math.max(0, view.items.length - 1));
		const previousId = this.current.items[this.current.selected]?.identity;
		const sameIdentity = view.items[selected]?.identity === previousId;
		this.current = {
			...this.current,
			status: "ready",
			items: view.items,
			coverage: view.coverage,
			allClear: view.allClear,
			selected,
			detailScroll: sameIdentity ? this.current.detailScroll : 0,
			announcements,
			notice: "",
		};
	}

	select(index: number): void {
		if (index < 0 || index >= this.current.items.length) return;
		this.current = { ...this.current, selected: index, detailsOpen: true, detailScroll: 0, notice: "" };
	}

	requestInspect(): void {
		const item = this.current.items[this.current.selected];
		if (!item) return;
		if (item.destination.kind !== "inspect-blocker") {
			this.current = { ...this.current, notice: INSPECT_ONLY_NOTICE };
			return;
		}
		if (!this.options.sendCommand || this.options.sendCommand(`/gsd blocker inspect ${item.destination.blockerId}`) === false) {
			this.current = { ...this.current, notice: "Inspect navigation is unavailable in this host. Details only; nothing is sent or changed." };
		}
	}

	/**
	 * Scroll the details panel by lines. The lower bound is 0; the upper bound is set
	 * by the view from its measured detail height via clampDetailScroll().
	 */
	scrollDetails(delta: number): void {
		const next = Math.max(0, this.current.detailScroll + delta);
		this.current = { ...this.current, detailScroll: Math.min(next, this.detailScrollLimit) };
	}

	/** Set by the view after each measured layout pass; zero until the view has measured. */
	private detailScrollLimit = Number.MAX_SAFE_INTEGER;

	clampDetailScroll(maxScroll: number): void {
		this.detailScrollLimit = Math.max(0, maxScroll);
		this.current = { ...this.current, detailScroll: Math.min(this.current.detailScroll, this.detailScrollLimit) };
	}

	close(): void {
		this.current = {
			...this.current,
			open: false,
			detailsOpen: false,
			focusRestoreTarget: "previous-editor",
		};
	}

	/**
	 * Normalized navigation only. The component maps the app keybinding
	 * `selectCancel` to "cancel" and `selectConfirm` to "open". Cancel closes
	 * details first, then the overlay. Any other action is intentionally unbound:
	 * there is no approve, retry, resolve, dismiss or recover action.
	 */
	handleKey(action: "cancel" | "open" | "up" | "down" | (string & {})): void {
		if (action === "cancel") {
			if (this.current.detailsOpen) {
				this.current = { ...this.current, detailsOpen: false };
			} else {
				this.close();
			}
		} else if (action === "open") {
			this.select(this.current.selected);
		} else if (action === "up" || action === "down") {
			const delta = action === "up" ? -1 : 1;
			const next = Math.min(Math.max(0, this.current.selected + delta), Math.max(0, this.current.items.length - 1));
			if (next !== this.current.selected) this.current = { ...this.current, selected: next, detailScroll: 0 };
		}
	}
}
