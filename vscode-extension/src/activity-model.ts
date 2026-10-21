// Project/App: gsd-pi
// File Purpose: vscode-free presentation-state model for the activity feed:
// event-to-row transitions plus connection/session lifecycle settlement with
// readable status semantics. Shared by GsdActivityFeedProvider and unit tests
// (issue #2930).

export type ActivityStatus = "running" | "success" | "error" | "interrupted";

/** Structural subset of the RPC agent session events the feed reacts to. */
export interface ActivityEvent {
	type: string;
	[key: string]: unknown;
}

export interface ActivityEntry {
	id: number;
	type: "tool" | "agent";
	label: string;
	detail: string;
	/** ThemeIcon id; the provider resolves it to a vscode.ThemeIcon. */
	icon: string;
	/** ThemeColor id; the provider resolves it to a vscode.ThemeColor. */
	color: string;
	timestamp: number;
	duration?: number;
	filePath?: string;
	status: ActivityStatus;
}

/**
 * Chart-role colors only. This feed shows execution activity, not test
 * outcomes, so it must not borrow testing.* semantics: a running start is
 * active (yellow), completion is success (green), a failed tool is an error
 * (red), and a disconnect/session rebind settles unfinished rows as
 * interrupted with outcome unknown (neutral foreground — losing the
 * connection does not prove the remote work failed or stopped).
 */
const RUNNING_COLOR = "charts.yellow";
const SUCCESS_COLOR = "charts.green";
const ERROR_COLOR = "charts.red";
const INTERRUPTED_COLOR = "charts.foreground";
const INTERRUPTED_ICON = "circle-slash";

/** Readable icon/color per outcome row state (color never carries the meaning alone). */
const OUTCOME_PRESENTATION = {
	success: { icon: "check", color: SUCCESS_COLOR },
	error: { icon: "error", color: ERROR_COLOR },
	interrupted: { icon: INTERRUPTED_ICON, color: INTERRUPTED_COLOR },
} as const;

const TOOL_ICONS: Record<string, string> = {
	Read: "file",
	Write: "new-file",
	Edit: "edit",
	Bash: "terminal",
	Grep: "search",
	Glob: "file-directory",
	Agent: "organization",
};

/** Session lifecycle reasons that rebind identity, matching the TUI chat controller. */
const SESSION_REBIND_REASONS = new Set(["new_session", "switch_session", "fork"]);

function toolSummary(toolName: string, toolInput: Record<string, unknown>): { label: string; filePath?: string } {
	const name = toolName ?? "Unknown";
	switch (name) {
		case "Read": {
			const p = String(toolInput?.file_path ?? toolInput?.path ?? "");
			const short = p.split(/[\\/]/).pop() ?? p;
			return { label: `Read ${short}`, filePath: p || undefined };
		}
		case "Write": {
			const p = String(toolInput?.file_path ?? "");
			const short = p.split(/[\\/]/).pop() ?? p;
			return { label: `Write ${short}`, filePath: p || undefined };
		}
		case "Edit": {
			const p = String(toolInput?.file_path ?? "");
			const short = p.split(/[\\/]/).pop() ?? p;
			return { label: `Edit ${short}`, filePath: p || undefined };
		}
		case "Bash": {
			const cmd = String(toolInput?.command ?? "").slice(0, 60);
			return { label: `Bash: ${cmd}` };
		}
		case "Grep": {
			const pat = String(toolInput?.pattern ?? "").slice(0, 40);
			return { label: `Grep: ${pat}` };
		}
		case "Glob": {
			const pat = String(toolInput?.pattern ?? "").slice(0, 40);
			return { label: `Glob: ${pat}` };
		}
		default:
			return { label: name };
	}
}

type RunOutcome = "success" | "error" | "interrupted";

/**
 * Terminal assistant stop reasons that downgrade a run from success. The
 * wire can end a run without an abortOrigin when the origin is unknown, but
 * the terminal assistant message then carries stopReason "error" or
 * "aborted" (packages/pi-ai StopReason), so both signals are checked.
 */
function runOutcome(abortOrigin: string | undefined, messages: unknown): RunOutcome {
	let stopReason: string | undefined;
	if (Array.isArray(messages)) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
			if (message && typeof message === "object" && message.role === "assistant") {
				if (typeof message.stopReason === "string") {
					stopReason = message.stopReason;
				}
				break;
			}
		}
	}
	if (abortOrigin === "error" || stopReason === "error") {
		return "error";
	}
	if (abortOrigin !== undefined || stopReason === "aborted") {
		return "interrupted";
	}
	return "success";
}

/**
 * Holds the activity rows and applies agent/tool/session transitions.
 *
 * Unfinished rows are settled (never left as permanent spinners): an
 * agent_end finishes them with the run's outcome, and a disconnect or
 * session rebind marks them interrupted with outcome unknown. What this
 * class guarantees is bounded: within one connection's event stream, an
 * agent_end without a pending run (duplicate, or after a lifecycle
 * settlement) is ignored, so late ends neither append phantom completions
 * nor flip settled rows back. Cross-process attribution is the client's
 * job (GsdClient drops stdout from replaced child processes); this model
 * sees only the events it is handed.
 *
 * `agent_start` carries no identifier on the wire, so agent rows are
 * tracked as one pending run per stream, matching the event's granularity.
 *
 * `handleEvent` returns whether presentation state changed, so adapters can
 * skip tree refreshes for ignored events.
 */
export class ActivityModel {
	private items: ActivityEntry[] = [];
	private nextId = 0;
	private runningTools = new Map<string, number>(); // toolUseId -> item id
	private runningAgentItems = new Set<number>();
	private runPending = false;
	private maxItems: number;

	constructor(maxItems = 100) {
		this.maxItems = maxItems;
	}

	getEntries(): ActivityEntry[] {
		return [...this.items];
	}

	setMaxItems(maxItems: number): void {
		this.maxItems = maxItems;
		this.evictOverflow();
	}

	/**
	 * Connection lifecycle: losing the connection settles every unfinished
	 * row as interrupted (outcome unknown). Reconnecting changes nothing
	 * about existing history; subsequent events append as usual.
	 */
	setConnected(connected: boolean): boolean {
		if (!connected) {
			return this.settleUnfinishedAsInterrupted();
		}
		return false;
	}

	/**
	 * Drops all history. A run in flight stays tracked: clearing the view
	 * must not orphan the still-running work or turn its eventual end into
	 * an unmatched event.
	 */
	clear(): void {
		this.items = [];
		this.runningTools.clear();
		this.runningAgentItems.clear();
	}

	handleEvent(evt: ActivityEvent): boolean {
		switch (evt.type) {
			case "agent_start": {
				const id = this.addItem({
					type: "agent",
					label: "Agent started",
					detail: "Agent began processing",
					icon: "play",
					color: RUNNING_COLOR,
					status: "running",
				});
				this.runningAgentItems.add(id);
				this.runPending = true;
				return true;
			}
			case "agent_end": {
				if (!this.runPending) {
					// Unmatched end (duplicate, or the run was already settled by
					// a disconnect/rebind): ignore it entirely.
					return false;
				}
				this.runPending = false;
				const abortOrigin = typeof evt.abortOrigin === "string" ? evt.abortOrigin : undefined;
				const outcome = runOutcome(abortOrigin, evt.messages);
				// A tool still marked running when the run ends is orphaned (its
				// own end event never arrived): settle it as outcome unknown.
				for (const item of this.items) {
					if (item.type === "tool" && item.status === "running") {
						this.markInterrupted(item);
					}
				}
				this.runningTools.clear();
				// The started row(s) take the same outcome as the run.
				for (const itemId of this.runningAgentItems) {
					const item = this.items.find((i) => i.id === itemId);
					if (!item) {
						continue;
					}
					if (outcome === "interrupted") {
						this.markInterrupted(item);
					} else {
						this.finishItem(item, outcome);
					}
				}
				this.runningAgentItems.clear();
				const presentation = OUTCOME_PRESENTATION[outcome];
				const detail = outcome === "success"
					? "Agent completed processing"
					: outcome === "error"
						? "Agent ended with an error"
						: abortOrigin !== undefined
							? `Agent stopped before completing (${abortOrigin})`
							: "Agent stopped before completing";
				this.addItem({
					type: "agent",
					label: "Agent finished",
					detail,
					icon: presentation.icon,
					color: presentation.color,
					status: outcome,
				});
				return true;
			}
			case "tool_execution_start": {
				const toolName = String(evt.toolName ?? "");
				const toolInput = (evt.toolInput ?? {}) as Record<string, unknown>;
				const toolUseId = String(evt.toolUseId ?? "");
				const { label, filePath } = toolSummary(toolName, toolInput);
				const iconName = TOOL_ICONS[toolName] ?? "tools";

				const id = this.addItem({
					type: "tool",
					label,
					detail: `Tool: ${toolName}`,
					icon: iconName,
					color: RUNNING_COLOR,
					status: "running",
					filePath,
				});

				if (toolUseId) {
					this.runningTools.set(toolUseId, id);
				}
				return true;
			}
			case "tool_execution_end": {
				const toolUseId = String(evt.toolUseId ?? "");
				const itemId = this.runningTools.get(toolUseId);
				if (itemId !== undefined) {
					this.runningTools.delete(toolUseId);
					const item = this.items.find((i) => i.id === itemId);
					if (item) {
						const isError = evt.error === true || evt.isError === true;
						this.finishItem(item, isError ? "error" : "success");
						return true;
					}
				}
				return false;
			}
			case "session_state_changed": {
				const reason = String(evt.reason ?? "");
				if (SESSION_REBIND_REASONS.has(reason)) {
					// Old-session activity must not stay running under (or be
					// attributed to) the successor session. No producer emits
					// this event yet: today new/switch transitions settle rows
					// via the programmatic abort's agent_end, while fork does
					// not abort first — the pre-existing fork gap is out of
					// scope for this presentation-side fix.
					return this.settleUnfinishedAsInterrupted();
				}
				return false;
			}
			default:
				return false;
		}
	}

	private finishItem(item: ActivityEntry, status: "success" | "error"): void {
		item.status = status;
		item.duration = Date.now() - item.timestamp;
		item.icon = OUTCOME_PRESENTATION[status].icon;
		item.color = OUTCOME_PRESENTATION[status].color;
	}

	private settleUnfinishedAsInterrupted(): boolean {
		let changed = false;
		for (const item of this.items) {
			if (item.status === "running") {
				this.markInterrupted(item);
				changed = true;
			}
		}
		this.runningTools.clear();
		this.runningAgentItems.clear();
		this.runPending = false;
		return changed;
	}

	/**
	 * Marks a row interrupted with outcome unknown: no duration (the work did
	 * not run to completion, so elapsed time would read as a finished
	 * measurement) and a neutral icon/color — losing the connection or
	 * abandoning a run does not prove the work failed or stopped.
	 */
	private markInterrupted(item: ActivityEntry): void {
		item.status = "interrupted";
		item.icon = OUTCOME_PRESENTATION.interrupted.icon;
		item.color = OUTCOME_PRESENTATION.interrupted.color;
	}

	private addItem(partial: Omit<ActivityEntry, "id" | "timestamp">): number {
		const id = this.nextId++;
		this.items.push({ ...partial, id, timestamp: Date.now() });
		this.evictOverflow();
		return id;
	}

	private evictOverflow(): void {
		while (this.items.length > this.maxItems) {
			const evicted = this.items.shift();
			if (!evicted) {
				break;
			}
			// Bookkeeping must not outlive its rows: keep the pending maps
			// bounded by what can still be settled.
			for (const [toolUseId, itemId] of this.runningTools) {
				if (itemId === evicted.id) {
					this.runningTools.delete(toolUseId);
				}
			}
			this.runningAgentItems.delete(evicted.id);
		}
	}
}
