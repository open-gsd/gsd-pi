// Project/App: gsd-pi
// File Purpose: DB → .planning/ projection. Parallel to writer.ts (which
// emits .gsd/). Produces the .planning/ markdown shape that gsd-core reads.
//
// Layout policy (spec §4.4): emits the layout recorded in the compat marker.
// v1 supports flat-phases; multi-milestone and legacy-milestone-dir are stubbed
// with a clear error until fixtures exist to validate them.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.js";
import { saveFile } from "../files.js";
import { removeProjectionFileSync } from "../atomic-write.js";
import { isClosedStatus } from "../status-guards.js";
import {
  computeProjectionSha,
  readCompatMarker,
  type PlanningLayout,
  writeCompatMarker,
} from "../compat/compat-marker.js";
import {
  applyPlanningProjectionWrites,
  type PlanningProjectionWrite,
} from "../compat/planning-compat.js";

export interface PlanningWrittenFiles {
  paths: string[];
  layout: PlanningLayout;
}

function planningRoot(basePath: string): string {
  return join(basePath, ".planning");
}

function removeObsoletePlanningProjections(
  basePath: string,
  desiredRelPaths: Set<string>,
): void {
  const marker = readCompatMarker(basePath);
  if (!marker.planning) return;

  let changed = false;
  for (const relPath of Object.keys(marker.planning.projections)) {
    if (desiredRelPaths.has(relPath) || !/-PLAN\.md$/i.test(relPath)) continue;
    const projection = marker.planning.projections[relPath]!;
    const absPath = join(planningRoot(basePath), relPath);
    if (existsSync(absPath)) {
      const currentSha = computeProjectionSha(readFileSync(absPath, "utf8"));
      if (currentSha !== projection.sha) continue;
      removeProjectionFileSync(absPath);
    }
    delete marker.planning.projections[relPath];
    changed = true;
  }
  if (changed) writeCompatMarker(basePath, marker);
}

function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Format a roadmap for the flat-phases layout. Mirrors the checkbox line
 * format that parsers.ts parsePhaseEntry recognizes: `- [x] NN — Title`.
 */
function formatPlanningRoadmapFlat(
  entries: Array<{ number: number; title: string; done: boolean }>,
): string {
  const lines = ["# Roadmap", "", "## Phases", ""];
  for (const e of entries) {
    const box = e.done ? "[x]" : "[ ]";
    lines.push(`- ${box} ${pad(e.number)} — ${e.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Format STATE.md in gsd-core's phase-progress schema. gsd-pi is authoritative
 * for status; this is a one-way DB→projection (edits to STATE.md are not
 * re-imported — see spec §7).
 */
function formatPlanningState(
  activeMilestone: string,
  totalPhases: number,
  completedPhases: number,
): string {
  const pct = totalPhases === 0 ? 0 : Math.round((completedPhases / totalPhases) * 100);
  const ts = new Date().toISOString();
  return [
    "---",
    "gsd_state_version: 1.0",
    `milestone: ${activeMilestone}`,
    'milestone_name: "milestone"',
    "status: active",
    `stopped_at: Phase 01 — in progress`,
    `last_updated: "${ts}"`,
    `last_activity: ${ts.slice(0, 10)}`,
    "progress:",
    `  total_phases: ${totalPhases}`,
    `  completed_phases: ${completedPhases}`,
    `  total_plans: ${totalPhases}`,
    `  completed_plans: ${completedPhases}`,
    `  percent: ${pct}`,
    "---",
    "",
    "# Project State",
    "",
    "Current Phase: **01**",
    "Status: **active**",
    "",
  ].join("\n");
}

function formatPlanningProject(title: string): string {
  return `# ${title}\n`;
}

/**
 * Format a phase plan file with the XML-tagged structure parsers.ts
 * parseOldPlan recognizes: <objective>, <tasks>, <verification>.
 */
function formatPlanningPlan(
  phaseNum: number,
  planNum: number,
  title: string,
  tasks: Array<{ id: string; title: string; estimate?: string; done?: boolean }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${pad(phaseNum)}-${pad(planNum)}: ${title}`, "");
  lines.push("<objective>");
  lines.push(`${title}.`);
  lines.push("</objective>");
  lines.push("");
  lines.push("<tasks>");
  for (const t of tasks) {
    const est = t.estimate ? ` _(${t.estimate})_` : "";
    // Render the checkbox from the task's DB status so a DB→.planning
    // projection preserves completion. Hardcoding `[ ]` here silently reset
    // every completed historical task to unchecked on each reconcile (#1276).
    const box = t.done ? "[x]" : "[ ]";
    lines.push(`- ${box} **${t.id}**: ${t.title}${est}`);
  }
  lines.push("</tasks>");
  lines.push("");
  lines.push("<verification>");
  lines.push("All tasks complete and tests pass.");
  lines.push("</verification>");
  lines.push("");
  return lines.join("\n");
}

/**
 * Project DB state to .planning/ in the recorded layout.
 * Reads DB directly (canonical source). Writes via saveFile (atomic).
 *
 * v1: flat-phases only. Each milestone's slices become sequentially-numbered
 * phase dirs; each task within a slice becomes a plan file (NN-MM-PLAN.md).
 */
export async function writePlanningDirectory(
  basePath: string,
  layout: PlanningLayout,
): Promise<PlanningWrittenFiles> {
  if (layout !== "flat-phases") {
    // v1: flat-phases only. multi-milestone and legacy-milestone-dir need
    // fixtures to validate the reverse-mapping (transformer.ts is non-injective
    // — three layouts collapse to one .gsd/ shape); stub until then.
    throw new Error(
      `writePlanningDirectory: layout "${layout}" not yet supported (v1 supports flat-phases only)`,
    );
  }

  const root = planningRoot(basePath);
  mkdirSync(root, { recursive: true });
  const paths: string[] = [];
  const projectionWrites: PlanningProjectionWrite[] = [];
  const toPlanningRel = (absPath: string): string =>
    relative(root, absPath).replace(/\\/g, "/");

  const milestones = getAllMilestones();
  if (milestones.length === 0) {
    return { paths, layout };
  }

  // Flat-phases: each slice becomes one phase. Tasks within become plan files.
  let phaseNum = 0;
  const roadmapEntries: Array<{ number: number; title: string; done: boolean }> = [];

  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id).filter((slice) => slice.status !== "skipped");
    for (const slice of slices) {
      phaseNum++;
      const phaseSlug = slugify(slice.title || slice.id, slice.id.toLowerCase());
      const phaseDirName = `${pad(phaseNum)}-${phaseSlug}`;
      const phaseDir = join(root, "phases", phaseDirName);
      mkdirSync(phaseDir, { recursive: true });

      const tasks = getSliceTasks(milestone.id, slice.id).filter((task) => task.status !== "skipped");
      const isDone =
        tasks.length > 0 && tasks.every((t) => isClosedStatus(t.status));
      roadmapEntries.push({
        number: phaseNum,
        title: slice.title || slice.id,
        done: isDone,
      });

      if (tasks.length === 0) {
        // Sketch / undecomposed slice — zero tasks. Do NOT emit an ingestible
        // *-PLAN.md here: the reverse transform maps one GSDTask per plan file
        // (transformer.ts mapSlice), so a placeholder would materialize a
        // phantom "Plan NN" task and flip the slice from "needs planning" to
        // "has a planned task", causing auto-mode to skip planning (issue #1285).
        // The phase dir is already created (mkdirSync above) and the slice is
        // listed in ROADMAP.md, so it round-trips with tasks = [] — the correct
        // sketch-slice shape.
      } else {
        for (let ti = 0; ti < tasks.length; ti++) {
          const task = tasks[ti]!;
          const planNum = ti + 1;
          const planPath = join(phaseDir, `${pad(phaseNum)}-${pad(planNum)}-PLAN.md`);
          const planContent = formatPlanningPlan(phaseNum, planNum, task.title || task.id, [
            {
              id: task.id,
              title: task.title || task.id,
              estimate: task.estimate || undefined,
              done: isClosedStatus(task.status),
            },
          ]);
          await saveFile(planPath, planContent);
          paths.push(planPath);
          projectionWrites.push({
            relPath: toPlanningRel(planPath),
            entities: [`${milestone.id}/${slice.id}/${task.id}`],
            sha: computeProjectionSha(planContent),
          });
        }
      }
    }
  }

  // If no slices produced any phases, emit a single empty phase dir + ROADMAP
  // entry so the layout stays discoverable. Do NOT write a placeholder
  // *-PLAN.md — an ingestible plan file would round-trip into a phantom task
  // (see the tasks.length === 0 branch above, issue #1285).
  if (roadmapEntries.length === 0) {
    const phaseDirName = `${pad(1)}-milestone`;
    const phaseDir = join(root, "phases", phaseDirName);
    mkdirSync(phaseDir, { recursive: true });
    roadmapEntries.push({ number: 1, title: milestones[0]!.title || milestones[0]!.id, done: false });
  }

  // Root files
  const milestoneEntities = milestones.map((m) => m.id);
  const roadmapPath = join(root, "ROADMAP.md");
  const roadmapContent = formatPlanningRoadmapFlat(roadmapEntries);
  await saveFile(roadmapPath, roadmapContent);
  paths.push(roadmapPath);
  projectionWrites.push({
    relPath: toPlanningRel(roadmapPath),
    entities: milestoneEntities,
    sha: computeProjectionSha(roadmapContent),
  });

  const completedPhases = roadmapEntries.filter((e) => e.done).length;
  const statePath = join(root, "STATE.md");
  const stateContent = formatPlanningState(milestones[0]!.id, roadmapEntries.length, completedPhases);
  await saveFile(statePath, stateContent);
  paths.push(statePath);
  projectionWrites.push({
    relPath: toPlanningRel(statePath),
    entities: [milestones[0]!.id],
    sha: computeProjectionSha(stateContent),
  });

  const projectPath = join(root, "PROJECT.md");
  const projectContent = formatPlanningProject(milestones[0]!.title || milestones[0]!.id);
  await saveFile(projectPath, projectContent);
  paths.push(projectPath);
  projectionWrites.push({
    relPath: toPlanningRel(projectPath),
    entities: [milestones[0]!.id],
    sha: computeProjectionSha(projectContent),
  });

  removeObsoletePlanningProjections(
    basePath,
    new Set(projectionWrites.map((write) => write.relPath)),
  );
  applyPlanningProjectionWrites(basePath, projectionWrites);
  return { paths, layout };
}
