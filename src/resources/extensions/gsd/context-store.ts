// GSD Context Store — Query Layer & Formatters
//
// Typed query functions for decisions and requirements from the DB views,
// with optional filtering. Format functions produce prompt-injectable markdown.
// All functions degrade gracefully: return empty results when DB unavailable, never throw.

import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import type { DbAdapter } from "./db-adapter.js";
import type { Decision, DecisionMadeBy, Requirement } from "./types.js";

// ─── Query Functions ───────────────────────────────────────────────────────

export interface DecisionQueryOpts {
	milestoneId?: string;
	scope?: string;
	includeSuperseded?: boolean;
}

export interface RequirementQueryOpts {
	class?: string;
	milestoneId?: string;
	sliceId?: string;
	status?: string;
}

function resolveReadAdapter(adapter?: DbAdapter): DbAdapter {
	const resolved = adapter ?? _getAdapter();
	if (!resolved) {
		throw new Error("Database adapter not available (db_unavailable)");
	}
	return resolved;
}

/**
 * Query active (non-superseded) decisions with optional filters.
 * - milestoneId: filters where when_context LIKE '%milestoneId%'
 * - scope: filters where scope = :scope (exact match)
 *
 * Returns [] if DB is not available. Never throws.
 */
export function queryDecisions(opts?: DecisionQueryOpts): Decision[] {
	if (!isDbAvailable()) return [];
	const adapter = _getAdapter();
	if (!adapter) return [];

	try {
		const clauses: string[] = ["superseded_by IS NULL"];
		const params: Record<string, unknown> = {};

		if (opts?.milestoneId) {
			clauses.push("when_context LIKE :milestone_pattern");
			params[":milestone_pattern"] = `%${opts.milestoneId}%`;
		}

		if (opts?.scope) {
			clauses.push("scope = :scope");
			params[":scope"] = opts.scope;
		}

		const sql = `SELECT * FROM decisions WHERE ${clauses.join(" AND ")} ORDER BY seq`;
		const rows = adapter.prepare(sql).all(params);

		return rows.map((row) => ({
			seq: row["seq"] as number,
			id: row["id"] as string,
			when_context: row["when_context"] as string,
			scope: row["scope"] as string,
			decision: row["decision"] as string,
			choice: row["choice"] as string,
			rationale: row["rationale"] as string,
			revisable: row["revisable"] as string,
			made_by:
				(row["made_by"] as string as import("./types.js").DecisionMadeBy) ??
				"agent",
			source: (row["source"] as string) ?? "discussion",
			superseded_by: null,
		}));
	} catch {
		return [];
	}
}

/**
 * Internal: shared core for the two memory-sourced decision queries. Reads
 * memory rows tagged with `sourceDecisionId` and reconstructs `Decision[]`
 * from their `structured_fields` JSON.
 *
 * @param includeSuperseded — when false, drops rows whose
 *   `structured_fields.superseded_by` is non-null. The supersedes-chain is
 *   captured by the backfill (`memory-backfill.ts`) and kept in sync by
 *   the backfill's drift auto-heal pass.
 */
function readDecisionsFromMemories(
	opts: DecisionQueryOpts | undefined,
	includeSuperseded: boolean,
): Decision[] {
	if (!isDbAvailable()) return [];
	const adapter = _getAdapter();
	if (!adapter) return [];

	try {
		const clauses: string[] = [
			"category = 'architecture'",
			'structured_fields LIKE \'%"sourceDecisionId":"%\'',
		];
		const params: Record<string, unknown> = {};

		if (opts?.milestoneId) {
			// when_context is a free-text JSON value; substring match preserves the
			// semantics of `when_context LIKE '%milestoneId%'` on the legacy table.
			clauses.push(
				"json_extract(structured_fields, '$.when_context') LIKE :milestone_pattern",
			);
			params[":milestone_pattern"] = `%${opts.milestoneId}%`;
		}

		if (opts?.scope) {
			// Stage 1 used `json_extract` in main (post-merge); preserve that
			// style here. Exact equality on the JSON value avoids the prefix
			// collision risk LIKE patterns had (scope=M001 vs scope=M001-S01).
			clauses.push("json_extract(structured_fields, '$.scope') = :scope");
			params[":scope"] = opts.scope;
		}

		const sql = `SELECT seq, structured_fields FROM memories WHERE ${clauses.join(" AND ")} ORDER BY seq`;
		const rows = adapter.prepare(sql).all(params) as Array<
			Record<string, unknown>
		>;

		const decisions: Decision[] = [];
		for (const row of rows) {
			const seq = row["seq"] as number;
			const sfRaw = row["structured_fields"] as string | null;
			if (!sfRaw) continue;
			let sf: Record<string, unknown>;
			try {
				sf = JSON.parse(sfRaw) as Record<string, unknown>;
			} catch {
				continue;
			}
			const sourceId = sf["sourceDecisionId"];
			if (typeof sourceId !== "string" || sourceId.length === 0) continue;
			if (sf["deleted"] === true) continue;

			// Decision-level superseded status lives in structured_fields.superseded_by
			// (written by mirrorDecisionToMemory / memory-backfill.ts). The top-level
			// memories.superseded_by column is intentionally never set for decision mirrors,
			// so active-only filtering must be done here in the JS loop.
			const supersededBy =
				typeof sf["superseded_by"] === "string"
					? (sf["superseded_by"] as string)
					: null;
			if (!includeSuperseded && supersededBy) continue;

			decisions.push({
				seq,
				id: sourceId,
				when_context:
					typeof sf["when_context"] === "string"
						? (sf["when_context"] as string)
						: "",
				scope: typeof sf["scope"] === "string" ? (sf["scope"] as string) : "",
				decision:
					typeof sf["decision"] === "string" ? (sf["decision"] as string) : "",
				choice:
					typeof sf["choice"] === "string" ? (sf["choice"] as string) : "",
				rationale:
					typeof sf["rationale"] === "string"
						? (sf["rationale"] as string)
						: "",
				revisable:
					typeof sf["revisable"] === "string"
						? (sf["revisable"] as string)
						: "",
				made_by: (typeof sf["made_by"] === "string"
					? sf["made_by"]
					: "agent") as DecisionMadeBy,
				source: typeof sf["source"] === "string" ? sf["source"] : "discussion",
				superseded_by: supersededBy,
			});
		}

		return decisions;
	} catch {
		return [];
	}
}

/**
 * ADR-013 Phase 6 cutover (Stage 1): read **active** decisions from the
 * `memories` table instead of the legacy `decisions` table. Returns the
 * same `Decision[]` shape as `queryDecisions` so downstream formatters
 * work unchanged.
 *
 * Filter semantics match `queryDecisions` exactly:
 * - active only (skips rows where `structured_fields.superseded_by` is set)
 * - `milestoneId`: substring match on `structured_fields.when_context`
 * - `scope`: exact match on `structured_fields.scope`
 *
 * Used by the prompt-inline path (`inlineDecisionsFromDb` in
 * `auto-prompts.ts`). For the projection regen (which renders superseded
 * rows too), see `getAllDecisionsFromMemories`.
 */
export function queryDecisionsFromMemories(
	opts?: DecisionQueryOpts,
): Decision[] {
	return readDecisionsFromMemories(opts, /* includeSuperseded */ false);
}

/**
 * ADR-013 Phase 6 cutover (Stage 2a): read **all** decisions (active +
 * superseded) from the `memories` table. Used by the DECISIONS.md
 * projection regen in `saveDecisionToDb`, which must render the full
 * supersedes-chain for the canonical register format.
 *
 * Equivalent to `SELECT * FROM decisions ORDER BY seq` over the legacy
 * table — but sourced from memories so the legacy table can be retired
 * in Stage 3. Includes `superseded_by` reconstructed from
 * `structured_fields.superseded_by` (populated by the backfill's drift
 * auto-heal pass).
 */
export function getAllDecisionsFromMemories(): Decision[] {
	return readDecisionsFromMemories(undefined, /* includeSuperseded */ true);
}

/** Decision IDs whose canonical memory authority is an explicit tombstone. */
export function getDeletedDecisionIdsFromMemories(): ReadonlySet<string> {
	if (!isDbAvailable()) return new Set();
	const adapter = _getAdapter();
	if (!adapter) return new Set();
	const rows = adapter
		.prepare(`SELECT structured_fields
    FROM memories
    WHERE category = 'architecture'
      AND instr(structured_fields, '"sourceDecisionId"') > 0`)
		.all() as Array<Record<string, unknown>>;
	const ids = new Set<string>();
	for (const row of rows) {
		const raw = row["structured_fields"];
		if (typeof raw !== "string")
			throw new Error("decision memory structured fields are invalid");
		let fields: Record<string, unknown>;
		try {
			fields = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			throw new Error("decision memory structured fields contain invalid JSON");
		}
		const id = fields["sourceDecisionId"];
		if (typeof id !== "string" || id.length === 0) {
			throw new Error("decision memory source identity is invalid");
		}
		if (fields["deleted"] === true) ids.add(id);
	}
	return ids;
}

/**
 * Query active (non-superseded) requirements with optional filters.
 * - milestoneId: combined with sliceId for precise filtering (e.g. %M005/S01%)
 * - sliceId: filters where primary_owner LIKE '%pattern%' OR supporting_slices LIKE '%pattern%'
 * - status: filters where status = :status (exact match)
 *
 * Returns [] if DB is not available. Never throws.
 */
export function queryRequirements(opts?: RequirementQueryOpts): Requirement[] {
	if (!isDbAvailable()) return [];
	const adapter = _getAdapter();
	if (!adapter) return [];

	try {
		const clauses: string[] = ["superseded_by IS NULL"];
		const params: Record<string, unknown> = {};

		// Combined milestone+slice filtering for precise scoping
		if (opts?.milestoneId && opts?.sliceId) {
			// Use combined pattern like %M005/S01% to avoid cross-milestone contamination
			clauses.push(
				"(primary_owner LIKE :combined_pattern OR supporting_slices LIKE :combined_pattern)",
			);
			params[":combined_pattern"] = `%${opts.milestoneId}/${opts.sliceId}%`;
		} else if (opts?.sliceId) {
			// Slice-only filtering (legacy behavior)
			clauses.push(
				"(primary_owner LIKE :slice_pattern OR supporting_slices LIKE :slice_pattern)",
			);
			params[":slice_pattern"] = `%${opts.sliceId}%`;
		} else if (opts?.milestoneId) {
			// Milestone-only filtering
			clauses.push(
				"(primary_owner LIKE :milestone_pattern OR supporting_slices LIKE :milestone_pattern)",
			);
			params[":milestone_pattern"] = `%${opts.milestoneId}%`;
		}

		if (opts?.status) {
			clauses.push("status = :status");
			params[":status"] = opts.status;
		}

		if (opts?.class) {
			clauses.push("class = :class");
			params[":class"] = opts.class;
		}

		const sql = `SELECT * FROM requirements WHERE ${clauses.join(" AND ")} ORDER BY id`;
		const rows = adapter.prepare(sql).all(params);

		return rows.map((row) => ({
			id: row["id"] as string,
			class: row["class"] as string,
			status: row["status"] as string,
			description: row["description"] as string,
			why: row["why"] as string,
			source: row["source"] as string,
			primary_owner: row["primary_owner"] as string,
			supporting_slices: row["supporting_slices"] as string,
			validation: row["validation"] as string,
			notes: row["notes"] as string,
			full_content: row["full_content"] as string,
			superseded_by: null,
		}));
	} catch {
		return [];
	}
}

// ─── Format Functions ──────────────────────────────────────────────────────

/**
 * Format decisions as a markdown table matching DECISIONS.md format.
 * Returns empty string for empty input.
 */
export function formatDecisionsForPrompt(decisions: Decision[]): string {
	if (decisions.length === 0) return "";

	const header =
		"| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |";
	const separator =
		"| --- | --- | --- | --- | --- | --- | --- | --- |";
	const rows = decisions.map(
		(d) =>
			`| ${d.id} | ${d.when_context} | ${d.scope} | ${d.decision} | ${d.choice} | ${d.rationale} | ${d.revisable} | ${d.made_by ?? "agent"} |`,
	);

	return [header, separator, ...rows].join("\n");
}

/**
 * Format requirements as structured H3 sections matching REQUIREMENTS.md format.
 * Returns empty string for empty input.
 */
export function formatRequirementsForPrompt(
	requirements: Requirement[],
): string {
	if (requirements.length === 0) return "";

	return requirements
		.map((r) => {
			const lines: string[] = [
				`### ${r.id}: ${r.description}`,
				"",
				`- **Class:** ${r.class}`,
				`- **Status:** ${r.status}`,
				`- **Why:** ${r.why}`,
				`- **Source:** ${r.source}`,
				`- **Primary Owner:** ${r.primary_owner}`,
			];

			if (r.supporting_slices) {
				lines.push(`- **Supporting Slices:** ${r.supporting_slices}`);
			}

			lines.push(`- **Validation:** ${r.validation}`);

			if (r.notes) {
				lines.push(`- **Notes:** ${r.notes}`);
			}

			return lines.join("\n");
		})
		.join("\n\n");
}

// ─── Artifact Query Functions ──────────────────────────────────────────────

/**
 * Query a hierarchy artifact by its relative path.
 * Returns the full_content string or null if not found/unavailable.
 * Never throws.
 */
export function queryArtifact(path: string): string | null {
	if (!isDbAvailable()) return null;
	const adapter = _getAdapter();
	if (!adapter) return null;

	try {
		const row = adapter
			.prepare("SELECT full_content FROM artifacts WHERE path = :path")
			.get({ ":path": path });
		if (!row) return null;
		const content = row["full_content"] as string;
		return content || null;
	} catch {
		return null;
	}
}

/**
 * Query PROJECT.md content from the artifacts table.
 * PROJECT.md is stored with the relative path 'PROJECT.md' by the importer.
 * Returns the content string or null if not found/unavailable.
 * Never throws.
 */
export function queryProject(): string | null {
	return queryArtifact("PROJECT.md");
}

// ─── Knowledge Query ───────────────────────────────────────────────────────

/**
 * Filter KNOWLEDGE.md sections by keyword matching.
 *
 * Structure-adaptive (issue #4719): files that organise entries as H3 items
 * under one or more H2 topics are filtered at H3 granularity. Files with only
 * H2 topic headers (no H3) fall back to H2-level filtering for backwards
 * compatibility.
 *
 * Matches keywords case-insensitively against:
 * 1. Section header text
 * 2. First paragraph of section content (up to first blank line or next heading)
 *
 * Per D020, returns empty string (not null) when no matches found.
 * This signals "no relevant knowledge" vs "file not found".
 *
 * @param content - Full KNOWLEDGE.md content
 * @param keywords - Keywords to match (case-insensitive)
 * @returns Concatenated matching sections with their original heading prefix, or empty string
 */
export async function queryKnowledge(
	content: string,
	keywords: string[],
): Promise<string> {
	if (!content || keywords.length === 0) return "";

	// Lazy import to avoid circular dependency
	const { extractAllSections } = await import("./files.js");

	// Prefer H3 granularity when available; fall back to H2 for H2-only files.
	// This prevents single-H2-with-many-H3 layouts from returning the entire
	// file on a keyword match against the H2 header or its first paragraph.
	const h3Sections = extractAllSections(content, 3);
	const useH3 = h3Sections.size > 0;
	const sections = useH3 ? h3Sections : extractAllSections(content, 2);
	if (sections.size === 0) return "";
	const prefix = useH3 ? "###" : "##";

	// Trim, lowercase, drop empties, and de-dupe so callers can pass raw
	// user-provided strings without risking empty-string / whitespace matches.
	const normalizedKeywords = [
		...new Set(
			keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0),
		),
	];
	if (normalizedKeywords.length === 0) return "";

	const matchingSections: string[] = [];

	for (const [header, body] of sections) {
		// Extract first paragraph: everything up to first blank line or next heading
		const firstParagraph = body.split(/\n\s*\n|\n#/)[0] || "";

		const headerLower = header.toLowerCase();
		const paragraphLower = firstParagraph.toLowerCase();

		const matches = normalizedKeywords.some(
			(kw) => headerLower.includes(kw) || paragraphLower.includes(kw),
		);

		if (matches) {
			matchingSections.push(`${prefix} ${header}\n\n${body}`);
		}
	}

	return matchingSections.join("\n\n");
}

// ─── Roadmap Excerpt Formatter ─────────────────────────────────────────────

/**
 * Format a minimal roadmap excerpt for prompt injection.
 * Parses the slice table from roadmap content, extracts:
 * 1. Header row + separator
 * 2. Predecessor row (if sliceId depends on one via the Depends column)
 * 3. Target slice row
 * 4. Reference directive pointing to full roadmap path
 *
 * Per D021, this minimizes injected content while preserving dependency awareness.
 * Returns empty string if sliceId is not found in the table.
 * Never throws.
 *
 * @param roadmapContent - Full content of the M###-ROADMAP.md file
 * @param sliceId - Target slice ID (e.g. 'S02')
 * @param roadmapPath - Optional path for reference directive (defaults to generic)
 */
export function formatRoadmapExcerpt(
	roadmapContent: string,
	sliceId: string,
	roadmapPath = "ROADMAP.md",
): string {
	if (!roadmapContent || !sliceId) return "";

	const lines = roadmapContent.split("\n");

	// Find the slice table header: | ID | Slice | ... (case insensitive)
	let headerIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line && /^\s*\|\s*ID\s*\|\s*Slice\s*\|/i.test(line)) {
			headerIndex = i;
			break;
		}
	}

	if (headerIndex === -1) return "";

	// The separator should be the next line (|---|---|...)
	const separatorIndex = headerIndex + 1;
	if (separatorIndex >= lines.length) return "";

	const headerLine = lines[headerIndex];
	const separatorLine = lines[separatorIndex];

	// Validate separator line looks like |---|---|... (may include : for alignment)
	if (!separatorLine || !/^\s*\|[\s:\-|]+\|/.test(separatorLine)) return "";

	// Parse table rows after separator
	interface SliceRow {
		line: string;
		id: string;
		depends: string;
	}

	const sliceRows: SliceRow[] = [];
	for (let i = separatorIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line || !line.trim().startsWith("|")) break; // End of table

		// Parse row: | ID | Slice | Risk | Depends | Done | After this |
		const cells = line.split("|").map((c) => c.trim());
		// cells[0] is empty (before first |), cells[1] is ID, etc.
		if (cells.length < 5) continue;

		const id = cells[1] || "";
		const depends = cells[4] || ""; // Depends column (0-indexed: empty, ID, Slice, Risk, Depends, ...)

		sliceRows.push({ line, id, depends });
	}

	// Find target slice row
	const targetRow = sliceRows.find((r) => r.id === sliceId);
	if (!targetRow) return "";

	// Find predecessor if target depends on one
	// Depends column may contain: '—', 'S01', 'S01, S02', etc.
	let predecessorRow: SliceRow | undefined;
	const dependsRaw = targetRow.depends;
	if (dependsRaw && dependsRaw !== "—" && dependsRaw !== "-") {
		// Extract first dependency (e.g. 'S01' from 'S01, S02')
		const depMatch = dependsRaw.match(/S\d+/);
		if (depMatch) {
			predecessorRow = sliceRows.find((r) => r.id === depMatch[0]);
		}
	}

	// Build excerpt
	const excerptLines: string[] = [headerLine!, separatorLine!];

	if (predecessorRow) {
		excerptLines.push(predecessorRow.line);
	}

	excerptLines.push(targetRow.line);

	// Add reference directive
	excerptLines.push("");
	excerptLines.push(`> See full roadmap: ${roadmapPath}`);

	return excerptLines.join("\n");
}

// ─── Point-lookup helpers (used by gsd_requirement_get / gsd_decision_get) ──

/**
 * Fetch a single requirement by stable ID (e.g. "R021").
 *
 * Returns null when the ID does not exist, when the requirement has been
 * superseded, or when the DB is unavailable. The caller distinguishes
 * "not found" from "db_unavailable" by checking `isDbAvailable()` separately.
 *
 * Never throws.
 */
export function getRequirementById(id: string): Requirement | null {
	if (!isDbAvailable()) return null;
	const adapter = _getAdapter();
	if (!adapter) return null;

	try {
		const row = adapter
			.prepare(
				"SELECT * FROM requirements WHERE id = :id AND superseded_by IS NULL",
			)
			.get({ ":id": id }) as Record<string, unknown> | undefined;

		if (!row) return null;

		return {
			id: row["id"] as string,
			class: row["class"] as string,
			status: row["status"] as string,
			description: row["description"] as string,
			why: row["why"] as string,
			source: row["source"] as string,
			primary_owner: (row["primary_owner"] as string) ?? "",
			supporting_slices: (row["supporting_slices"] as string) ?? "",
			validation: (row["validation"] as string) ?? "",
			notes: (row["notes"] as string) ?? "",
			full_content: (row["full_content"] as string) ?? "",
			superseded_by: null,
		};
	} catch {
		return null;
	}
}

/**
 * Fetch a single decision by stable ID (e.g. "D007").
 *
 * Reads from the canonical `memories` table (ADR-013 Stage 3). Returns null
 * when the ID does not exist, the memory is a tombstone (`deleted: true`),
 * or the DB is unavailable.
 *
 * `includeSuperseded` (default false): when false, returns null for
 * decisions that have a non-null `structured_fields.superseded_by`.
 *
 * Never throws.
 */
export function getDecisionById(
	id: string,
	includeSuperseded = false,
): Decision | null {
	if (!isDbAvailable()) return null;
	const adapter = _getAdapter();
	if (!adapter) return null;

	try {
		const rows = adapter
			.prepare(
				`SELECT seq, structured_fields FROM memories
         WHERE category = 'architecture'
           AND json_extract(structured_fields, '$.sourceDecisionId') = :id`,
			)
			.all({ ":id": id }) as Array<Record<string, unknown>>;

		for (const row of rows) {
			const sfRaw = row["structured_fields"] as string | null;
			if (!sfRaw) continue;
			let sf: Record<string, unknown>;
			try {
				sf = JSON.parse(sfRaw) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (sf["deleted"] === true) return null;
			const supersededBy =
				typeof sf["superseded_by"] === "string"
					? (sf["superseded_by"] as string)
					: null;
			if (!includeSuperseded && supersededBy) return null;

			return {
				seq: row["seq"] as number,
				id,
				when_context:
					typeof sf["when_context"] === "string"
						? (sf["when_context"] as string)
						: "",
				scope: typeof sf["scope"] === "string" ? (sf["scope"] as string) : "",
				decision:
					typeof sf["decision"] === "string" ? (sf["decision"] as string) : "",
				choice:
					typeof sf["choice"] === "string" ? (sf["choice"] as string) : "",
				rationale:
					typeof sf["rationale"] === "string"
						? (sf["rationale"] as string)
						: "",
				revisable:
					typeof sf["revisable"] === "string"
						? (sf["revisable"] as string)
						: "",
				made_by: (typeof sf["made_by"] === "string"
					? sf["made_by"]
					: "agent") as import("./types.js").DecisionMadeBy,
				source:
					typeof sf["source"] === "string"
						? (sf["source"] as string)
						: "discussion",
				superseded_by: supersededBy,
			};
		}

		return null;
	} catch {
		return null;
	}
}

// ─── Strict Query Functions (error propagation + SQL LIMIT) ────────────────
//
// These functions are used by canonical read tools. They throw on query errors
// (corrupt schema, missing table) so callers can distinguish "not found" from
// "query failed". They apply LIMIT in SQL (never materialize unbounded rows).

/**
 * Query requirements with SQL-level LIMIT applied.
 * Throws if query fails (corrupt schema, missing table).
 * Never materializes >limit rows; stops at DB level.
 */
export function queryRequirementsWithLimit(
	opts?: RequirementQueryOpts & { limit?: number },
 	adapter?: DbAdapter,
): Requirement[] {
	const db = resolveReadAdapter(adapter);

	const clauses: string[] = ["superseded_by IS NULL"];
	const params: Record<string, unknown> = {};

	if (opts?.milestoneId && opts?.sliceId) {
		clauses.push(
			"(primary_owner LIKE :combined_pattern OR supporting_slices LIKE :combined_pattern)",
		);
		params[":combined_pattern"] = `%${opts.milestoneId}/${opts.sliceId}%`;
	} else if (opts?.sliceId) {
		clauses.push(
			"(primary_owner LIKE :slice_pattern OR supporting_slices LIKE :slice_pattern)",
		);
		params[":slice_pattern"] = `%${opts.sliceId}%`;
	} else if (opts?.milestoneId) {
		clauses.push(
			"(primary_owner LIKE :milestone_pattern OR supporting_slices LIKE :milestone_pattern)",
		);
		params[":milestone_pattern"] = `%${opts.milestoneId}%`;
	}

	if (opts?.status) {
		clauses.push("status = :status");
		params[":status"] = opts.status;
	}

	if (opts?.class) {
		clauses.push("class = :class");
		params[":class"] = opts.class;
	}

	// LIMIT applied at SQL level (never after materialization)
	const limit = Math.min(opts?.limit ?? 200, 500);
	const sql = `SELECT * FROM requirements WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT :limit`;
	params[":limit"] = limit;

	const rows = db.prepare(sql).all(params);

	return rows.map((row) => ({
		id: row["id"] as string,
		class: row["class"] as string,
		status: row["status"] as string,
		description: row["description"] as string,
		why: row["why"] as string,
		source: row["source"] as string,
		primary_owner: row["primary_owner"] as string,
		supporting_slices: row["supporting_slices"] as string,
		validation: row["validation"] as string,
		notes: row["notes"] as string,
		full_content: row["full_content"] as string,
		superseded_by: null,
	}));
}

/**
 * Query active decisions with SQL-level LIMIT applied.
 * Throws if query fails.
 */
export function queryDecisionsWithLimit(
	opts?: DecisionQueryOpts & { limit?: number },
 	adapter?: DbAdapter,
): Decision[] {
	const db = resolveReadAdapter(adapter);

	const clauses: string[] = [
		"category = 'architecture'",
		"json_valid(structured_fields)",
		"json_extract(structured_fields, '$.sourceDecisionId') IS NOT NULL",
		"IFNULL(json_extract(structured_fields, '$.deleted'), 0) != 1",
	];
	const params: Record<string, unknown> = {};

	if (opts?.milestoneId) {
		clauses.push(
			"json_extract(structured_fields, '$.when_context') LIKE :milestone",
		);
		params[":milestone"] = `%${opts.milestoneId}%`;
	}

	if (opts?.scope) {
		clauses.push("json_extract(structured_fields, '$.scope') = :scope");
		params[":scope"] = opts.scope;
	}

	// Only active (non-superseded) unless caller specifies includeSuperseded
	if (!opts?.includeSuperseded) {
		clauses.push("json_extract(structured_fields, '$.superseded_by') IS NULL");
	}

	// LIMIT at SQL level
	const limit = Math.min(opts?.limit ?? 200, 500);
	const sql = `SELECT seq, structured_fields FROM memories WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT :limit`;
	params[":limit"] = limit;

	const rows = db.prepare(sql).all(params) as Array<
		Record<string, unknown>
	>;

	return rows.map((row) => {
		const sf = JSON.parse(row["structured_fields"] as string);
		return {
			seq: row["seq"] as number,
			id: sf.sourceDecisionId,
			scope: sf.scope ?? "",
			decision: sf.decision ?? "",
			choice: sf.choice ?? "",
			rationale: sf.rationale ?? "",
			when_context: sf.when_context ?? "",
			made_by: (sf.made_by ?? "collaborative") as DecisionMadeBy,
			revisable: sf.revisable,
			source: sf.source ?? "discussion",
			superseded_by: sf.superseded_by ?? null,
		};
	});
}

/**
 * Fetch single requirement by ID. Throws on query errors.
 */
export function getRequirementByIdStrict(
	id: string,
	adapter?: DbAdapter,
): Requirement | null {
	const db = resolveReadAdapter(adapter);

	const row = db
		.prepare(
			"SELECT * FROM requirements WHERE id = :id AND superseded_by IS NULL",
		)
		.get({ ":id": id }) as Record<string, unknown> | undefined;

	if (!row) return null;

	return {
		id: row["id"] as string,
		class: row["class"] as string,
		status: row["status"] as string,
		description: row["description"] as string,
		why: row["why"] as string,
		source: row["source"] as string,
		primary_owner: (row["primary_owner"] as string) ?? "",
		supporting_slices: (row["supporting_slices"] as string) ?? "",
		validation: (row["validation"] as string) ?? "",
		notes: (row["notes"] as string) ?? "",
		full_content: (row["full_content"] as string) ?? "",
		superseded_by: null,
	};
}

/**
 * Fetch single decision by ID. Throws on query errors.
 */
export function getDecisionByIdStrict(
	id: string,
	includeSuperseded = false,
 	adapter?: DbAdapter,
): Decision | null {
	const db = resolveReadAdapter(adapter);

	const supersededClause = includeSuperseded
		? ""
		: "AND json_extract(structured_fields, '$.superseded_by') IS NULL";
	const rows = db
		.prepare(
			`SELECT seq, structured_fields FROM memories
       WHERE category = 'architecture'
         AND json_valid(structured_fields)
         AND json_extract(structured_fields, '$.sourceDecisionId') = :id
         ${supersededClause}
       ORDER BY seq DESC LIMIT 1`,
		)
		.all({ ":id": id }) as Array<Record<string, unknown>>;

	if (!rows.length) return null;

	const sf = JSON.parse(rows[0]!["structured_fields"] as string);
	if (sf.deleted === true) return null;

	return {
		seq: rows[0]!["seq"] as number,
		id: sf.sourceDecisionId,
		scope: sf.scope ?? "",
		decision: sf.decision ?? "",
		choice: sf.choice ?? "",
		rationale: sf.rationale ?? "",
		when_context: sf.when_context ?? "",
		made_by: (sf.made_by ?? "collaborative") as DecisionMadeBy,
		revisable: sf.revisable,
		source: sf.source ?? "discussion",
		superseded_by: sf.superseded_by ?? null,
	};
}
