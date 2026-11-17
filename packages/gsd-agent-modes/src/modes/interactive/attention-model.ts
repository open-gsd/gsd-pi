/**
 * Pure attention model for the native overview (#2932, GSD-W086).
 *
 * Inputs are already-read, same-project snapshots from existing typed sources.
 * This module never opens a database, never sends a response, never resolves
 * a blocker or request, and never derives a classification or action from
 * prose, title, path or timestamp. Unknown kinds fall back to inspect-only.
 */

export type Namespace = "workflow" | "auto-pause" | "interaction";
export type Completeness = "complete" | "partial" | "unknown";

export interface AttentionSource {
	namespace: Namespace;
	status: "available" | "unavailable";
	completeness: Completeness;
	rows: readonly Record<string, unknown>[];
	reason?: string;
}

export const WORKFLOW_KINDS = [
	"missing_authority", "missing_access", "external_dependency", "consent",
	"ambiguous_intent", "subjective_uat", "user_limit",
] as const;
/** auto_pauses extends the workflow vocabulary with two pause-only kinds. */
export const PAUSE_ONLY_KINDS = ["user_request", "machine_fixable"] as const;

export const INSPECT_ONLY_NOTICE =
	"No verified owner-controlled destination. Details only; nothing is sent or changed.";

const SAFE_MAX = 240;

/** Strip control characters, ANSI escapes and newlines; collapse whitespace. */
/** Detail text keeps its full meaning up to a generous bound; titles stay short. */
const DETAIL_MAX = 2000;

export function safeDetailText(input: string): string {
	return safeTextWithLimit(input, DETAIL_MAX);
}

export function safeText(input: string): string {
	return safeTextWithLimit(input, SAFE_MAX);
}

function safeTextWithLimit(input: string, limit: number): string {
	return input
		// eslint-disable-next-line no-control-regex
		.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, " ")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
}

export function classifyWorkflowBlockerKind(kind: unknown): (typeof WORKFLOW_KINDS)[number] | null {
	return typeof kind === "string" && (WORKFLOW_KINDS as readonly string[]).includes(kind)
		? (kind as (typeof WORKFLOW_KINDS)[number]) : null;
}

export function classifyPauseKind(kind: unknown): string | null {
	if (typeof kind !== "string") return null;
	if ((PAUSE_ONLY_KINDS as readonly string[]).includes(kind)) return kind;
	return classifyWorkflowBlockerKind(kind);
}

/** Identity is namespaced so equal raw IDs from different sources never merge. */
export function attentionIdentity(input: { namespace: Namespace; id: string }): string {
	return JSON.stringify([input.namespace, input.id]);
}

export interface AttentionItem {
	identity: string;
	namespace: Namespace;
	id: string;
	classification: string;
	title: string;
	owner: string;
	freshness: "current" | "historical";
	destination: { kind: "inspect-blocker"; blockerId: string } | { kind: "details-only"; notice: string };
	actions: string[];
	/** Safe read-only details shown in the native Inspect details panel. */
	details: { kind: string; requestedAction: string; sourceIdentity: string; text: string };
}

export interface CoverageEntry {
	namespace: Namespace;
	status: "available" | "unavailable";
	completeness: Completeness;
	reason?: string;
}

export interface AttentionView {
	items: AttentionItem[];
	coverage: CoverageEntry[];
	allClear: boolean;
}

const OWNERS = new Set(["user", "external"]);

/** Namespaces that must all be read completely before an all-clear can be claimed. */
export const EXPECTED_NAMESPACES: readonly Namespace[] = ["workflow", "auto-pause", "interaction"];

export function buildAttentionView(
	sources: readonly AttentionSource[],
	options: { currentRevision?: number } = {},
): AttentionView {
	const seen = new Map<string, AttentionItem>();
	const coverage: CoverageEntry[] = [];

	for (const source of sources) {
		coverage.push({
			namespace: source.namespace,
			status: source.status,
			completeness: source.completeness,
			...(source.reason ? { reason: safeText(source.reason) } : {}),
		});
		if (source.status !== "available") continue;

		for (const raw of source.rows) {
			const id = typeof raw["blockerId"] === "string" ? raw["blockerId"]
				: typeof raw["id"] === "string" ? raw["id"] : "";
			if (!id) continue;
			const identity = attentionIdentity({ namespace: source.namespace, id });
			if (seen.has(identity)) continue;

			const isPause = source.namespace === "auto-pause";
			const kind = isPause ? classifyPauseKind(raw["blockerKind"]) : classifyWorkflowBlockerKind(raw["blockerKind"]);
			const owner = typeof raw["resolutionOwner"] === "string" && OWNERS.has(raw["resolutionOwner"])
				? raw["resolutionOwner"] : "unknown";
			// Unknown ownership makes the row unclassified even when its kind is known.
			const ownerKnown = owner !== "unknown";
			const classification = kind !== null && ownerKnown ? kind : "unclassified";

			// Only a verified workflow-blocker ID with a known kind and owner may be inspected.
			const inspectable = source.namespace === "workflow" && kind !== null && ownerKnown;
			const title = safeText(
				typeof raw["description"] === "string" && raw["description"]
					? raw["description"] : `Attention ${classification}`,
			);
			// Opening revision is historical provenance only. A mismatch never makes a row stale.

			seen.set(identity, {
				identity,
				namespace: source.namespace,
				id,
				classification,
				title,
				owner,
				freshness: "current",
				details: {
					kind: kind ?? safeText(String(raw["blockerKind"] ?? "unknown")),
					requestedAction: safeText(typeof raw["requestedAction"] === "string" ? raw["requestedAction"] : ""),
					sourceIdentity: safeText(`${source.namespace}:${id}`),
					text: safeDetailText(
						typeof raw["description"] === "string" && raw["description"]
							? raw["description"] : `Attention ${classification}`,
					),
				},
				destination: inspectable
					? { kind: "inspect-blocker", blockerId: id }
					: { kind: "details-only", notice: INSPECT_ONLY_NOTICE },
				actions: inspectable ? ["inspect-blocker"] : [],
			});
		}
	}

	const items = [...seen.values()];
	// Every expected namespace must be present and complete before all-clear. A
	// missing namespace is unknown coverage, never an implicit empty result.
	const present = new Set(sources.map((s) => s.namespace));
	for (const expected of EXPECTED_NAMESPACES) {
		if (!present.has(expected)) {
			coverage.push({ namespace: expected, status: "unavailable", completeness: "unknown", reason: "source-not-read" });
		}
	}
	const complete = EXPECTED_NAMESPACES.every((ns) => {
		const src = sources.find((s) => s.namespace === ns);
		return src !== undefined && src.status === "available" && src.completeness === "complete";
	});
	const allClear = items.length === 0 && complete;
	return { items, coverage, allClear };
}
