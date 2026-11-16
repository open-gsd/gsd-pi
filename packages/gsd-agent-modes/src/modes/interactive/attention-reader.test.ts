import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttentionReader, type ReadSeam } from "./attention-reader.ts";

// Fake read seam: records every call so mutation-freedom is observable.
function seam(opts: {
	authority?: Record<string, unknown> | undefined;
	blockers?: Record<string, unknown>[];
	pauses?: Record<string, unknown>[];
	throwOn?: "authority" | "blockers";
}) {
	const calls: string[] = [];
	const s: ReadSeam = {
		withReadOnlySnapshot: <T>(path: string, inspect: (q: (sql: string) => Record<string, unknown>[]) => T): T => {
			calls.push(`snapshot:${path}`);
			const q = (sql: string) => {
				calls.push(`sql:${sql.trim().split(/\s+/).slice(0, 3).join(" ")}`);
				if (/project_authority/.test(sql)) {
					if (opts.throwOn === "authority") throw new Error("locked");
					return opts.authority ? [opts.authority] : [];
				}
				if (/workflow_blockers/.test(sql)) {
					if (opts.throwOn === "blockers") throw new Error("locked");
					return opts.blockers ?? [];
				}
				if (/auto_pause/.test(sql)) return opts.pauses ?? [];
				return [];
			};
			return inspect(q);
		},
	};
	return { s, calls };
}

const auth = { project_id: "P1", project_root_realpath: "/root/a", revision: 4, authority_epoch: 1 };

test("reads only through the read-only snapshot seam; never opens an engine or writer", async () => {
	const { s, calls } = seam({ authority: auth, blockers: [] });
	const reader = createAttentionReader({ databasePath: "/root/a/.gsd/gsd.db", projectRoot: "/root/a", seam: s });
	await reader.readSnapshot();
	assert.ok(calls.every((c) => c.startsWith("snapshot:") || c.startsWith("sql:SELECT")), calls.join(" | "));
	assert.ok(!calls.some((c) => /INSERT|UPDATE|DELETE|CREATE|PRAGMA user_version/i.test(c)));
});

test("no compatible project authority is unavailable, never all-clear", async () => {
	const { s } = seam({ authority: undefined, blockers: [] });
	const reader = createAttentionReader({ databasePath: "/root/a/.gsd/gsd.db", projectRoot: "/root/a", seam: s });
	const snap = await reader.readSnapshot();
	assert.ok(snap.sources.every((src) => src.status === "unavailable" && src.completeness === "unknown"));
});

test("a database bound to a different checkout is refused, not adopted or rebound", async () => {
	const { s, calls } = seam({ authority: { ...auth, project_root_realpath: "/root/OTHER" }, blockers: [] });
	const reader = createAttentionReader({ databasePath: "/root/a/.gsd/gsd.db", projectRoot: "/root/a", seam: s });
	const snap = await reader.readSnapshot();
	assert.ok(snap.sources.every((src) => src.status === "unavailable"));
	assert.ok(!calls.some((c) => /project_authority.*(INSERT|UPDATE)/i.test(c)));
});

test("a read error is unavailable for that namespace, never an empty complete list", async () => {
	const { s } = seam({ authority: auth, throwOn: "blockers" });
	const reader = createAttentionReader({ databasePath: "/root/a/.gsd/gsd.db", projectRoot: "/root/a", seam: s });
	const snap = await reader.readSnapshot();
	const wf = snap.sources.find((x) => x.namespace === "workflow")!;
	assert.equal(wf.status, "unavailable");
	assert.equal(wf.completeness, "unknown");
});

test("a truncated read reports partial coverage", async () => {
	const many = Array.from({ length: 501 }, (_, i) => ({ blockerId: `B-${i}`, blockerKind: "consent", resolutionOwner: "user", description: "d", openedProjectRevision: 1 }));
	const { s } = seam({ authority: auth, blockers: many });
	const reader = createAttentionReader({ databasePath: "/root/a/.gsd/gsd.db", projectRoot: "/root/a", seam: s, limit: 500 });
	const snap = await reader.readSnapshot();
	const wf = snap.sources.find((x) => x.namespace === "workflow")!;
	assert.equal(wf.completeness, "partial");
	assert.equal(wf.rows.length, 500);
});

test("missing database file is unavailable and no file is created", async () => {
	const reader = createAttentionReader({
		databasePath: "/does/not/exist/gsd.db",
		projectRoot: "/does/not/exist",
		seam: { withReadOnlySnapshot: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } },
	});
	const snap = await reader.readSnapshot();
	assert.ok(snap.sources.every((src) => src.status === "unavailable"));
});
