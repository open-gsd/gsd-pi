import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildExistingMilestonesContext } from "../../guided-flow-queue.ts";
import type { GSDState, MilestoneRegistryEntry } from "../../types.ts";

const LARGE_BODY = "A".repeat(150_000);
const LARGE_DRAFT = "D".repeat(150_000);
const LARGE_ROADMAP = "R".repeat(150_000);

function makeState(registry: MilestoneRegistryEntry[]): GSDState {
  return {
    activeMilestone: registry.find(m => m.status === "active") ?? null,
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry,
  };
}

function writeMilestoneArtifact(base: string, mid: string, suffix: string, content: string): void {
  mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-${suffix}.md`), content);
}

describe("queue active/pending milestone context budget", () => {
  test("summarizes active and pending artifacts with source paths and bounded excerpts", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "gsd-queue-active-budget-"));
    try {
      writeMilestoneArtifact(tmpBase, "M001", "CONTEXT", `# Active context\n\n${LARGE_BODY}\nEND_ACTIVE_CONTEXT`);
      writeMilestoneArtifact(tmpBase, "M001", "ROADMAP", `# Active roadmap\n\n${LARGE_ROADMAP}\nEND_ACTIVE_ROADMAP`);
      writeMilestoneArtifact(tmpBase, "M002", "CONTEXT-DRAFT", `# Pending draft\n\n${LARGE_DRAFT}\nEND_PENDING_DRAFT`);
      writeMilestoneArtifact(tmpBase, "M002", "ROADMAP", `# Pending roadmap\n\n${LARGE_ROADMAP}\nEND_PENDING_ROADMAP`);

      const registry: MilestoneRegistryEntry[] = [
        { id: "M001", title: "Active milestone", status: "active" },
        { id: "M002", title: "Pending milestone", status: "pending" },
      ];

      const context = await buildExistingMilestonesContext(tmpBase, ["M001", "M002"], makeState(registry));

      assert.match(context, /Source: `.gsd\/milestones\/M001\/M001-CONTEXT.md`/);
      assert.match(context, /Source: `.gsd\/milestones\/M001\/M001-ROADMAP.md`/);
      assert.match(context, /Source: `.gsd\/milestones\/M002\/M002-CONTEXT-DRAFT.md`/);
      assert.match(context, /Source: `.gsd\/milestones\/M002\/M002-ROADMAP.md`/);
      assert.match(context, /Read `.gsd\/milestones\/M001\/M001-CONTEXT.md` for full content/);
      assert.equal(context.includes("END_ACTIVE_CONTEXT"), false);
      assert.equal(context.includes("END_ACTIVE_ROADMAP"), false);
      assert.equal(context.includes("END_PENDING_DRAFT"), false);
      assert.equal(context.includes("END_PENDING_ROADMAP"), false);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("caps the total existing milestones context", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "gsd-queue-total-budget-"));
    try {
      const registry: MilestoneRegistryEntry[] = [];
      const milestoneIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const mid = `M${String(i).padStart(3, "0")}`;
        milestoneIds.push(mid);
        registry.push({ id: mid, title: `Pending milestone ${i}`, status: "pending" });
        writeMilestoneArtifact(tmpBase, mid, "CONTEXT", `# ${mid} context\n\n${LARGE_BODY}\nEND_${mid}_CONTEXT`);
        writeMilestoneArtifact(tmpBase, mid, "ROADMAP", `# ${mid} roadmap\n\n${LARGE_ROADMAP}\nEND_${mid}_ROADMAP`);
      }

      const context = await buildExistingMilestonesContext(tmpBase, milestoneIds, makeState(registry));

      assert.ok(
        context.length <= 120_000,
        `expected total context to stay within budget, got ${context.length} chars`,
      );
      assert.match(context, /Existing milestones context truncated/);
      for (let i = 1; i <= 5; i++) {
        const mid = `M${String(i).padStart(3, "0")}`;
        assert.match(context, new RegExp(`### ${mid}: Pending milestone ${i}`));
        assert.match(context, new RegExp(`Source: \`.gsd/milestones/${mid}/${mid}-CONTEXT.md\``));
        assert.match(context, new RegExp(`Source: \`.gsd/milestones/${mid}/${mid}-ROADMAP.md\``));
      }
      assert.equal(context.includes("END_M005_ROADMAP"), false);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
