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
const PAUSE_SQL = `SELECT CAST(id AS TEXT) AS blockerId, blocker_kind AS blockerKind,
  'user' AS resolutionOwner, COALESCE(pause_reason, '') AS description,
  '' AS requestedAction, paused_at AS openedAt
  FROM auto_pauses WHERE closed_at IS NULL
  ORDER BY paused_at, id LIMIT :limit`;

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
						const rows = query(sql.replace(":limit", String(limit + 1)));
						const truncated = rows.length > limit;
						return {
							namespace,
							status: "available",
							completeness: truncated ? "partial" : "complete",
							rows: truncated ? rows.slice(0, limit) : rows,
							...(truncated ? { reason: "truncated" } : {}),
						};
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
				// Any failure is explicit unavailability; never an empty complete view.
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
