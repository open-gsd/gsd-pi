// gsd-pi — Guided menus decide from database rows, not from projection files.
//
// The /gsd and /gsd discuss menus offer actions from the slice rows and the
// saved CONTEXT / RESEARCH artifact rows. A ROADMAP, CONTEXT or RESEARCH file
// with no row changes nothing, and a row with no file is enough (#3441).

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { invalidateAllCaches } from "../cache.ts";
import { closeDatabase, insertArtifact, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { showDiscuss, showSmartEntry } from "../guided-flow.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

let base: string;

afterEach(() => {
  closeDatabase();
  invalidateAllCaches();
  cleanup(base);
});

/** A project with one active milestone M001 and the given slices. */
function openProject(sliceIds: string[] = []): void {
  base = makeTempRepo("gsd-guided-rows-");
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  for (const id of sliceIds) insertSlice({ id, milestoneId: "M001", title: `Slice ${id}` });
  invalidateAllCaches();
}

function writeProjection(relativePath: string, content: string): void {
  const path = join(base, ".gsd", "milestones", relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function saveArtifact(artifactType: string, milestoneId: string, sliceId: string | null): void {
  insertArtifact({
    path: `milestones/${milestoneId}/${sliceId ? `slices/${sliceId}/${sliceId}` : milestoneId}-${artifactType}.md`,
    artifact_type: artifactType,
    milestone_id: milestoneId,
    slice_id: sliceId,
    task_id: null,
    full_content: `# ${artifactType}\n`,
  });
  invalidateAllCaches();
}

/**
 * An interactive session. Each menu is recorded as its option labels. The
 * menu is answered with the first option that contains `answers[n]`, or left
 * unanswered.
 */
function makeSession(answers: string[] = []) {
  const menus: string[][] = [];
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: () => {},
      setStatus: () => {},
      custom: async () => undefined,
      select: async (_title: string, options: string[]) => {
        const answer = answers[menus.length];
        menus.push(options);
        return answer ? options.find((option) => option.includes(answer)) : undefined;
      },
    },
  } as any;
  const pi = {
    sendMessage: () => {
      throw new Error("the menu must not dispatch a prompt in these tests");
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any;
  return { ctx, pi, menus };
}

const ROADMAP_WITH_SLICE = "# M001\n\n## Slices\n- [ ] **S01: First slice** `risk:low` `depends:[]`\n";

test("a milestone with no slice rows is offered a roadmap, whatever the ROADMAP file says", async () => {
  openProject();
  writeProjection("M001/M001-ROADMAP.md", ROADMAP_WITH_SLICE);
  writeProjection("M001/M001-CONTEXT.md", "# Context\n");

  const { ctx, pi, menus } = makeSession();
  await showSmartEntry(ctx, pi, base);

  const menu = menus.at(-1)!.join("\n");
  assert.match(menu, /Create roadmap/);
  assert.doesNotMatch(menu, /Go auto/);
  assert.match(menu, /Discuss first/, "a CONTEXT file with no row is not a captured context");
});

test("a saved milestone CONTEXT row with no file removes the discuss offer", async () => {
  openProject();
  saveArtifact("CONTEXT", "M001", null);

  const { ctx, pi, menus } = makeSession();
  await showSmartEntry(ctx, pi, base);

  const menu = menus.at(-1)!.join("\n");
  assert.match(menu, /Create roadmap.*Context captured/);
  assert.doesNotMatch(menu, /Discuss first/);
});

test("the slice planning menu offers discuss and research until the rows are saved", async () => {
  openProject(["S01"]);
  saveArtifact("CONTEXT", "M001", null);
  writeProjection("M001/slices/S01/S01-CONTEXT.md", "# Context\n");
  writeProjection("M001/slices/S01/S01-RESEARCH.md", "# Research\n");

  const withFilesOnly = makeSession();
  await showSmartEntry(withFilesOnly.ctx, withFilesOnly.pi, base);
  const offered = withFilesOnly.menus.at(-1)!.join("\n");
  assert.match(offered, /Plan S01/);
  assert.match(offered, /Discuss S01 first/);
  assert.match(offered, /Research S01 first/);

  saveArtifact("CONTEXT", "M001", "S01");
  saveArtifact("RESEARCH", "M001", "S01");
  const withRows = makeSession();
  await showSmartEntry(withRows.ctx, withRows.pi, base);
  const saved = withRows.menus.at(-1)!.join("\n");
  assert.match(saved, /Plan S01/);
  assert.doesNotMatch(saved, /Discuss S01 first/);
  assert.doesNotMatch(saved, /Research S01 first/);
});

test("the discuss pickers mark a slice and a queued milestone from saved rows only", async () => {
  openProject(["S01", "S02"]);
  saveArtifact("CONTEXT", "M001", null);
  saveArtifact("CONTEXT", "M001", "S01");
  writeProjection("M001/slices/S02/S02-CONTEXT.md", "# Context\n");
  // M002 has rows and no files; M003 has files and no rows.
  for (const id of ["M002", "M003"]) insertMilestone({ id, title: `Queued ${id}`, status: "queued", depends_on: ["M001"] });
  // The draft row of M002 stays after its final CONTEXT is saved; the context wins.
  saveArtifact("CONTEXT-DRAFT", "M002", null);
  saveArtifact("CONTEXT", "M002", null);
  insertSlice({ id: "S01", milestoneId: "M002", title: "Planned" });
  saveArtifact("CONTEXT-DRAFT", "M003", null);
  writeProjection("M003/M003-CONTEXT.md", "# Context\n");
  writeProjection("M003/M003-ROADMAP.md", ROADMAP_WITH_SLICE);

  const { ctx, pi, menus } = makeSession(["Discuss a future/planned milestone", "M002: Queued M002"]);
  await showDiscuss(ctx, pi, base);

  const [slicePicker, milestonePicker, modePicker] = menus;
  assert.match(modePicker!.join("\n"), /Full discussion/, "M002 has a final context, so its old draft is no fast path");
  assert.match(slicePicker!.join("\n"), /S01: Slice S01.*discussed ✓/);
  assert.match(slicePicker!.join("\n"), /S02: Slice S02.*not discussed/);
  assert.match(milestonePicker!.join("\n"), /M002: Queued M002.*context ✓ · roadmap ✓/);
  assert.match(milestonePicker!.join("\n"), /M003: Queued M003.*draft context$/m);
});
