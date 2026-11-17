/**
 * Mutation-free same-project attention reader (#2932, GSD-W086).
 *
 * Consumes only an injected read-only snapshot seam (production: the existing
 * `inspectSqliteReadOnlySnapshot`, which applies query_only and never bootstraps,
 * binds, adopts or cuts over). Never opens a writable engine, never imports the
 * workflow DB opener, never rebinds a checkout, and never turns a failed or
 * absent read into an empty "all clear".
 */
import type { AttentionSource, Namespace } from "./attention-model.js";

export type ReadRows = (sql: string) => Record<string, unknown>[];

export interface ReadSeam {
	withReadOnlySnapshot<T>(path: string, inspect: (query: ReadRows) => T): T;
}

export interface AttentionReaderInput {
	databasePath: string;
	projectRoot: string;
	seam: ReadSeam;
	/** Maximum rows per namespace; reaching it reports partial coverage. */
	limit?: number;
}

export interface AttentionSnapshotRead {
	/** null when the read failed: a failure never binds or replaces the project identity. */
	projectKey: string | null;
	sources: AttentionSource[];
}

const DEFAULT_LIMIT = 200;

const WORKFLOW_SQL = `SELECT blocker_id AS blockerId, blocker_kind AS blockerKind,
  resolution_owner AS resolutionOwner, description, requested_action AS requestedAction,
  opened_project_revision AS openedProjectRevision
  FROM workflow_blockers WHERE blocker_status = 'open'
  ORDER BY opened_project_revision, blocker_id LIMIT :limit`;

/**
 * Current worker pauses (auto_pauses): one open row per scope while closed_at IS NULL.
 * Own vocabulary (includes user_request, machine_fixable). A pause does not need a
 * workflow blocker row, so pauses are read directly, never inferred from links.
 * Columns from db-auto-pause-schema.ts.
 */
// p.* allows old schemas without the optional blocker_id column to retain pauses.
const PAUSE_SQL = `SELECT p.*, CAST(id AS TEXT) AS blockerId, blocker_kind AS blockerKind,
  'unknown' AS resolutionOwner, COALESCE(pause_reason, '') AS description,
  '' AS requestedAction, paused_at AS openedAt
  FROM auto_pauses p WHERE closed_at IS NULL
  ORDER BY paused_at, id LIMIT :limit`;

// Ownership is provenance, not resolution eligibility. In particular external owners
// are legitimate, while the native openPauseBlockerRow producer may record user for
// the same kind. Require the explicit link and its current same-project lifecycle;
// the supported unit shapes mirror the existing pause lifecycle lookup contract.
const PAUSE_OWNER_SQL = `SELECT CAST(p.id AS TEXT) AS pauseId, MIN(b.resolution_owner) AS resolutionOwner
  FROM auto_pauses p
  JOIN workflow_blockers b ON b.blocker_id = p.blocker_id
  JOIN workflow_item_lifecycles l ON l.lifecycle_id = b.lifecycle_id
  JOIN project_authority a ON a.singleton = 1
    AND b.project_id = a.project_id AND l.project_id = a.project_id
  WHERE p.closed_at IS NULL AND b.blocker_status = 'open'
    AND b.blocker_kind = p.blocker_kind AND b.resolution_owner IN ('user', 'external')
    AND b.blocker_kind IN ('missing_authority', 'missing_access', 'external_dependency',
      'consent', 'ambiguous_intent', 'subjective_uat', 'user_limit')
    AND (SELECT COUNT(*) FROM workflow_blockers candidate WHERE candidate.blocker_id = p.blocker_id) = 1
    AND (SELECT COUNT(*) FROM workflow_item_lifecycles candidate WHERE candidate.lifecycle_id = b.lifecycle_id) = 1
    AND l.lifecycle_status IN ('pending', 'ready', 'in_progress', 'paused')
    AND l.milestone_id = p.milestone_id
    AND (
      (l.item_kind = 'task' AND p.unit_type IN ('execute-task', 'replan-task')
        AND p.unit_id = l.milestone_id || '/' || l.slice_id || '/' || l.task_id)
      OR (l.item_kind = 'slice' AND p.unit_type IN (
        'complete-slice', 'discuss-slice', 'plan-slice', 'research-slice', 'refine-slice',
        'replan-slice', 'run-uat', 'reassess-roadmap', 'rewrite-docs')
        AND p.unit_id = l.milestone_id || '/' || l.slice_id)
      OR (l.item_kind = 'milestone' AND p.unit_type IN (
        'complete-milestone', 'research-milestone', 'plan-milestone', 'discuss-milestone',
        'validate-milestone', 'rewrite-docs') AND p.unit_id = l.milestone_id)
    )
    AND (SELECT COUNT(*) FROM auto_pauses linked
      WHERE linked.blocker_id = p.blocker_id AND linked.closed_at IS NULL) = 1
  GROUP BY p.id HAVING COUNT(*) = 1
  ORDER BY p.paused_at, p.id LIMIT :limit`;

/** Missing optional association support is unknown ownership, not a lost pause. */
function supportsPauseOwners(query: ReadRows): boolean {
	const columns = {
		auto_pauses: ["blocker_id", "milestone_id", "unit_type", "unit_id"],
		workflow_blockers: ["blocker_id", "project_id", "lifecycle_id", "blocker_kind", "resolution_owner", "blocker_status"],
		workflow_item_lifecycles: ["lifecycle_id", "project_id", "item_kind", "milestone_id", "slice_id", "task_id", "lifecycle_status"],
	};
	return Object.entries(columns).every(([table, required]) => {
		const present = new Set(query(`PRAGMA table_info(${table})`).map((row) => row["name"]));
		return required.every((column) => present.has(column));
	});
}

/** Open questions only; `answered`/`withdrawn` are not attention. Columns from db-conversation-foundation-schema.ts. */
const QUESTION_SQL = `SELECT question_id AS id, question_text AS description, created_at AS createdAt
  FROM workflow_open_questions WHERE question_status = 'open'
  ORDER BY created_project_revision, question_id LIMIT :limit`;

const AUTHORITY_SQL = `SELECT project_id, project_root_realpath, revision, authority_epoch
  FROM project_authority WHERE singleton = 1`;

function unavailable(namespace: Namespace, reason: string): AttentionSource {
	return { namespace, status: "unavailable", completeness: "unknown", rows: [], reason };
}

export function createAttentionReader(input: AttentionReaderInput) {
	const limit = input.limit ?? DEFAULT_LIMIT;

	return {
		async readSnapshot(): Promise<AttentionSnapshotRead> {
			let read: AttentionSnapshotRead;
			try {
				read = input.seam.withReadOnlySnapshot(input.databasePath, (query) => {
					const authorityRows = query(AUTHORITY_SQL);
					const authority = authorityRows[0];
					if (!authority || typeof authority["project_id"] !== "string" || !authority["project_id"]) {
						throw new Error("no-compatible-authority");
					}
					// Checkout binding is verified, never adopted or rewritten.
					if (authority["project_root_realpath"] !== input.projectRoot) {
						throw new Error("checkout-not-bound");
					}
					const projectKey = authority["project_id"];

					const sourceFrom = (namespace: Namespace, sql: string): AttentionSource => {
						try {
							let rows = query(sql.replace(":limit", String(limit + 1)));
							const truncated = rows.length > limit;
							const reasons = truncated ? ["truncated"] : [];
							if (namespace === "interaction") {
								reasons.push("durable workflow questions read; live native prompts unread");
							}
							if (namespace === "auto-pause") {
								const owners = new Map<unknown, unknown>();
								if (rows.some((row) => typeof row["blocker_id"] === "string" && row["blocker_id"])) {
									if (supportsPauseOwners(query)) {
										for (const owner of query(PAUSE_OWNER_SQL.replace(":limit", String(limit + 1)))) {
											owners.set(owner["pauseId"], owner["resolutionOwner"]);
										}
									} else reasons.push("pause owner association unavailable");
								}
								rows = rows.map((row) => ({ ...row, resolutionOwner: owners.get(row["blockerId"]) ?? "unknown" }));
							}
							return {
								namespace,
								status: "available",
								completeness: reasons.length ? "partial" : "complete",
								rows: truncated ? rows.slice(0, limit) : rows,
								...(reasons.length ? { reason: reasons.join("; ") } : {}),
							};
						} catch {
							// Query-local failure only. The outer seam still owns open/config,
							// transaction and cleanup failure for the entire snapshot.
							return unavailable(namespace, "namespace query failed");
						}
					};

					return {
						projectKey,
						sources: [
							sourceFrom("workflow", WORKFLOW_SQL),
							sourceFrom("auto-pause", PAUSE_SQL),
							sourceFrom("interaction", QUESTION_SQL),
						],
					};
				});
			} catch (error) {
				// Snapshot-wide failure discards every result; never an empty complete view.
				const reason = error instanceof Error ? error.message : "read-failed";
				return {
					projectKey: null,
					sources: [unavailable("workflow", reason), unavailable("auto-pause", reason), unavailable("interaction", reason)],
				};
			}
			return read;
		},
	};
}
