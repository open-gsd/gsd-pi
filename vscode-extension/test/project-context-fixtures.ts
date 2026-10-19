import type { ProjectProgress, ProjectSnapshot } from "../../packages/contracts/src/rpc.ts";

export const PRIVATE_SENTINEL = "REJECTED_PAYLOAD_MUST_NOT_REACH_CHAT";

export function progressFixture(): ProjectProgress {
	return {
		activeMilestone: { id: "M1", title: "Milestone" }, activeSlice: null, activeTask: null,
		phase: "executing", nextAction: "Continue",
		milestones: { total: 1, done: 0, active: 1, pending: 0, parked: 0 },
		slices: { total: 0, done: 0, active: 0, pending: 0 },
		tasks: { total: 0, done: 0, pending: 0 }, requirements: null, blockers: [],
		readMetadata: { source: "database", authority: "db-authoritative" },
	};
}

export function snapshotFixture(): ProjectSnapshot {
	const progress = progressFixture();
	return {
		authority: { projectId: "project-1", schemaVersion: null, revision: 0, authorityEpoch: 0 },
		current: { activeMilestone: progress.activeMilestone, activeSlice: null, activeTask: null, phase: "executing", nextAction: "Continue" },
		progress: { milestones: progress.milestones, slices: progress.slices, tasks: progress.tasks },
		blockers: [], openQuestions: [],
		verification: { assessments: { total: 0, pass: 0, fail: 0 }, evidence: { total: 0, passed: 0, failed: 0 } },
		milestones: { items: [{ id: "M1", title: "Milestone", status: "active", sequence: 0 }], truncated: false },
		capturedAt: "2026-10-08T00:00:00.000Z",
	};
}

export const blockerFixture = {
	blockerId: "B1", blockerKind: "decision", resolutionOwner: "human", description: "Blocked",
	requestedAction: "Resolve", openedAt: "2026-10-08T00:00:00.000Z", openedProjectRevision: 0,
};

export function invalidProgressFixtures(): Array<[string, unknown]> {
	return [
		["null", null], ["scalar", PRIVATE_SENTINEL], ["array", []],
		["missing provenance", { ...progressFixture(), readMetadata: undefined }],
		["projection", { ...progressFixture(), readMetadata: { source: "projection", authority: "projection-fallback" } }],
		["wrong authority", { ...progressFixture(), readMetadata: { source: "database", authority: "projection-fallback" } }],
		["wrong source", { ...progressFixture(), readMetadata: { source: "projection", authority: "db-authoritative" } }],
		["active reference", { ...progressFixture(), activeTask: { id: "T1" } }],
		["phase", { ...progressFixture(), phase: null }], ["nextAction", { ...progressFixture(), nextAction: [] }],
		["negative counter", { ...progressFixture(), tasks: { total: -1, done: 0, pending: 0 } }],
		["fraction counter", { ...progressFixture(), requirements: { active: 0.5, validated: 0, deferred: 0, outOfScope: 0 } }],
		["nonfinite counter", { ...progressFixture(), slices: { total: Infinity, done: 0, active: 0, pending: 0 } }],
		["blockers", { ...progressFixture(), blockers: [{ description: PRIVATE_SENTINEL }] }],
		["blocker rows", { ...progressFixture(), blockerRows: [{ ...blockerFixture, openedProjectRevision: "0" }] }],
		["detail flag", { ...progressFixture(), milestoneDetailsTruncated: "false" }],
		["detail tree", { ...progressFixture(), milestoneDetails: [{ id: "M1", title: "Milestone", status: "active", truncated: false, slices: [{ id: "S1", title: "Slice", status: "active", truncated: false, tasks: [{ id: "T1" }] }] }] }],
		["error envelope", { ...progressFixture(), error: PRIVATE_SENTINEL }],
	];
}

export function invalidSnapshotFixtures(): Array<[string, unknown]> {
	const base = snapshotFixture();
	return [
		["null", null], ["scalar", PRIVATE_SENTINEL], ["array", []],
		["missing authority", { ...base, authority: undefined }],
		["missing project", { ...base, authority: { ...base.authority, projectId: undefined } }],
		["schema version", { ...base, authority: { ...base.authority, schemaVersion: "1" } }],
		["revision", { ...base, authority: { ...base.authority, revision: -1 } }],
		["epoch", { ...base, authority: { ...base.authority, authorityEpoch: 0.5 } }],
		["current", { ...base, current: { ...base.current, activeSlice: {} } }],
		["progress", { ...base, progress: { ...base.progress, tasks: {} } }],
		["blockers", { ...base, blockers: [{ ...blockerFixture, description: 1 }] }],
		["question", { ...base, openQuestions: [{ questionId: "Q1", questionText: PRIVATE_SENTINEL }] }],
		["verification", { ...base, verification: { ...base.verification, evidence: { total: 0, passed: 0, failed: NaN } } }],
		["milestone", { ...base, milestones: { items: [{ id: "M1", title: "Milestone", status: "active", sequence: "0" }], truncated: false } }],
		["truncation", { ...base, blockersTruncated: 0 }],
		["milestone truncation", { ...base, milestones: { ...base.milestones, truncated: undefined } }],
		["capture timestamp", { ...base, capturedAt: null }],
		["lifecycle version", { ...base, lifecycleStatusVersion: 2 }],
		["lifecycle status", { ...base, milestones: { ...base.milestones, items: [{ ...base.milestones.items[0], lifecycleStatus: "unknown" }] } }],
		["error envelope", { ...base, isError: true, message: PRIVATE_SENTINEL }],
	];
}
