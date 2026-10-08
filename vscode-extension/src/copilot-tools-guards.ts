// Project/App: gsd-pi
// File Purpose: Pure, vscode-import-free guards for the Copilot Chat language
// model tools in copilot-tools.ts, so their invocation contract is
// unit-testable outside the Extension Development Host.

import { resolve } from "node:path";
import type { LifecycleStatus, LIFECYCLE_STATUS_VERSION, ProjectProgress, ProjectSnapshot } from "@opengsd/contracts" with { "resolution-mode": "import" };

/** Structural subset of vscode.CancellationToken actually needed here. */
export interface CancellationSignal {
	isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export function assertEmptyToolInput(input: unknown): void {
	if (input === undefined) return;
	if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
		throw new Error("GSD project read tools do not accept input parameters. They use the active workspace project.");
	}
}

export function assertActiveWorkspaceRoot(projectRoot: string, workspaceFolderPaths: readonly string[]): void {
	if (workspaceFolderPaths.length !== 1) {
		throw new Error("GSD project read tools require exactly one workspace folder. Open the target project in its own VS Code window.");
	}
	const activeRoot = resolve(workspaceFolderPaths[0]);
	const clientRoot = resolve(projectRoot);
	if (activeRoot !== clientRoot) {
		throw new Error("GSD project read tools require the active workspace folder to match the connected GSD agent project. Restart the GSD agent for this workspace, then retry.");
	}
}

/**
 * Runs `operation` only after confirming the token was not already
 * cancelled, so an already-cancelled invocation never sends the underlying
 * request. `operation` is lazy (a thunk) precisely to keep that ordering.
 */
export async function awaitWithCancellation<T>(operation: () => Promise<T>, token: CancellationSignal): Promise<T> {
	if (token.isCancellationRequested) {
		throw new Error("GSD project read was cancelled.");
	}

	return await new Promise<T>((resolve, reject) => {
		const cancellation = token.onCancellationRequested(() => reject(new Error("GSD project read was cancelled.")));
		operation().then(resolve, reject).finally(() => cancellation.dispose());
	});
}


const PAYLOAD_ERROR = "GSD project read returned noncanonical or incompatible data. Restart the GSD agent and retry; update the GSD runtime and extension if the problem persists.";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, keys: readonly string[]): boolean {
	return record(value) && keys.every(key => typeof value[key] === "string");
}

function counter(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function counters(value: unknown, keys: readonly string[]): boolean {
	return record(value) && keys.every(key => counter(value[key]));
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "boolean";
}

function list(value: unknown, validate: (item: unknown) => boolean): boolean {
	return Array.isArray(value) && value.every(validate);
}

function activeReference(value: unknown): boolean {
	return value === null || strings(value, ["id", "title"]);
}

function current(value: unknown): boolean {
	return strings(value, ["phase", "nextAction"]) && record(value)
		&& ["activeMilestone", "activeSlice", "activeTask"].every(key => activeReference(value[key]));
}

function progressCounters(value: unknown): boolean {
	return record(value)
		&& counters(value.milestones, ["total", "done", "active", "pending", "parked"])
		&& counters(value.slices, ["total", "done", "active", "pending"])
		&& counters(value.tasks, ["total", "done", "pending"]);
}

function blocker(value: unknown): boolean {
	return strings(value, ["blockerId", "blockerKind", "resolutionOwner", "description", "requestedAction", "openedAt"])
		&& record(value) && counter(value.openedProjectRevision);
}

function statusItem(value: unknown): boolean {
	return strings(value, ["id", "title", "status"]);
}

function sliceDetail(value: unknown): boolean {
	return statusItem(value) && record(value) && typeof value.truncated === "boolean" && list(value.tasks, statusItem);
}

function milestoneDetail(value: unknown): boolean {
	return statusItem(value) && record(value) && typeof value.truncated === "boolean" && list(value.slices, sliceDetail);
}

function payload(value: unknown): value is Record<string, unknown> {
	// RPC/error envelopes are not project payloads, even if they also contain valid-looking fields.
	return record(value) && !["error", "isError", "success", "command", "type"].some(key => key in value);
}

/** Shared metadata remains optional elsewhere; native chat requires the DB read path. */
export function assertCanonicalProjectProgress(value: unknown): asserts value is ProjectProgress {
	if (!payload(value) || !current(value) || !progressCounters(value)
		|| !(value.requirements === null || counters(value.requirements, ["active", "validated", "deferred", "outOfScope"]))
		|| !list(value.blockers, item => typeof item === "string")
		|| !record(value.readMetadata) || value.readMetadata.source !== "database" || value.readMetadata.authority !== "db-authoritative"
		|| (value.blockerRows !== undefined && !list(value.blockerRows, blocker))
		|| (value.milestoneDetails !== undefined && !list(value.milestoneDetails, milestoneDetail))
		|| !optionalBoolean(value, "milestoneDetailsTruncated") || !optionalBoolean(value, "milestoneDetailsTasksTruncated")) {
		throw new Error(PAYLOAD_ERROR);
	}
}

// Type-only imports keep the CommonJS extension compatible with the ESM-only contracts package.
// Behavioral tests compare these values to the authoritative contract, including every status.
const lifecycleVersion: typeof LIFECYCLE_STATUS_VERSION = 1;
const lifecycleStatuses = ["pending", "ready", "in_progress", "paused", "completed", "cancelled", "blocker-accepted"] satisfies readonly LifecycleStatus[];

function snapshotMilestone(value: unknown): boolean {
	return statusItem(value) && record(value) && counter(value.sequence)
		&& (value.lifecycleStatus === undefined || value.lifecycleStatus === null
			|| lifecycleStatuses.some(status => status === value.lifecycleStatus));
}

/** Snapshot authority has its own contract; DB schemaVersion is not a payload version. */
export function assertCanonicalProjectSnapshot(value: unknown): asserts value is ProjectSnapshot {
	if (!payload(value) || !strings(value.authority, ["projectId"]) || !record(value.authority)
		|| (value.authority.schemaVersion !== null && !counter(value.authority.schemaVersion))
		|| !counter(value.authority.revision) || !counter(value.authority.authorityEpoch)
		|| !current(value.current) || !progressCounters(value.progress)
		|| !list(value.blockers, blocker) || !optionalBoolean(value, "blockersTruncated")
		|| !list(value.openQuestions, item => strings(item, ["questionId", "questionText", "createdAt"]))
		|| !optionalBoolean(value, "openQuestionsTruncated")
		|| !record(value.verification) || !counters(value.verification.assessments, ["total", "pass", "fail"])
		|| !counters(value.verification.evidence, ["total", "passed", "failed"])
		|| !record(value.milestones) || !list(value.milestones.items, snapshotMilestone) || typeof value.milestones.truncated !== "boolean"
		|| typeof value.capturedAt !== "string"
		|| (value.lifecycleStatusVersion !== undefined && value.lifecycleStatusVersion !== lifecycleVersion)) {
		throw new Error(PAYLOAD_ERROR);
	}
}
