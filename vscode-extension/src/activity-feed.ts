import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";
import { ActivityModel, type ActivityEntry } from "./activity-model.js";

/**
 * TreeDataProvider that shows real-time tool executions from the GSD agent.
 * Listens to tool_execution_start/end and agent_start/end events.
 *
 * Presentation state and transition rules live in the vscode-free
 * ActivityModel (issue #2930) so they stay unit-testable outside a host;
 * this class only maps model rows onto tree items.
 */
export class GsdActivityFeedProvider implements vscode.TreeDataProvider<ActivityEntry>, vscode.Disposable {
	public static readonly viewId = "gsd-activity";

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly model = new ActivityModel();
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.model.setMaxItems(vscode.workspace.getConfiguration("gsd").get<number>("activityFeedMaxItems", 100));

		this.disposables.push(
			this._onDidChangeTreeData,
			client.onEvent((evt) => {
				if (this.model.handleEvent(evt)) {
					this._onDidChangeTreeData.fire();
				}
			}),
			client.onConnectionChange((connected) => {
				if (this.model.setConnected(connected)) {
					this._onDidChangeTreeData.fire();
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("gsd.activityFeedMaxItems")) {
					this.model.setMaxItems(
						vscode.workspace.getConfiguration("gsd").get<number>("activityFeedMaxItems", 100),
					);
					// setMaxItems trims immediately; the tree must reflect it.
					this._onDidChangeTreeData.fire();
				}
			}),
		);
	}

	getTreeItem(element: ActivityEntry): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(element.icon, new vscode.ThemeColor(element.color));
		item.description = element.duration !== undefined
			? `${element.duration}ms`
			: element.status === "running"
				? "running..."
				: element.status === "interrupted"
					? "interrupted"
					: "";
		item.tooltip = `${element.detail}\n${new Date(element.timestamp).toLocaleTimeString()}`;

		if (element.filePath) {
			item.command = {
				command: "vscode.open",
				title: "Open File",
				arguments: [vscode.Uri.file(element.filePath)],
			};
		}

		return item;
	}

	getChildren(): ActivityEntry[] {
		// Show newest first
		return [...this.model.getEntries()].reverse();
	}

	clear(): void {
		this.model.clear();
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
