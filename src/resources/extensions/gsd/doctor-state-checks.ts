import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadFile, parseSummary, saveFile, parseTaskPlanMustHaves, countMustHavesMentionedInSummary } from "./files.js";
import { getMilestone, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { resolveMilestoneFile, resolveMilestonePath, resolveSliceFile, resolveSlicePath, resolveTaskFile, resolveTasksDir, legacyMilestonesDir, relMilestoneFile, relSliceFile, relTaskFile, relSlicePath, relGsdRootFile, resolveGsdRootFile, relMilestonePath } from "./paths.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { deriveState } from "./state.js";
import { isClosedStatus } from "./status-guards.js";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import type { RoadmapSliceEntry } from "./types.js";
import { runProviderChecks } from "./doctor-providers.js";
import { validateTitle } from "./validation.js";

function matchesScope(unitId: string, scope?: string): boolean {
  if (!scope) return true;
  return unitId === scope || unitId.startsWith(`${scope}/`);
}

function auditRequirements(content: string | null): DoctorIssue[] {
  if (!content) return [];
  const issues: DoctorIssue[] = [];
  const blocks = content.split(/^###\s+/m).slice(1);

  for (const block of blocks) {
    const idMatch = block.match(/^(R\d+)/);
    if (!idMatch) continue;
    const requirementId = idMatch[1];
    const status = block.match(/^-\s+Status:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    const owner = block.match(/^-\s+Primary owning slice:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";
    const notes = block.match(/^-\s+Notes:\s+(.+)$/m)?.[1]?.trim().toLowerCase() ?? "";

    if (status === "active" && (!owner || owner === "none" || owner === "none yet")) {
      // #4414: Downgrade to warning. A newly-created requirement has
      // primary_owner='' by default until the planning agent wires it to
      // a slice via gsd_requirement_update. Flagging this as an error
      // during normal planning is noisy — the real failure mode is when
      // it persists past milestone completion, which is covered by other
      // audits. Keep the signal but don't treat it as a blocker.
      issues.push({
        severity: "warning",
        code: "active_requirement_missing_owner",
        scope: "project",
        unitId: requirementId,
        message: `${requirementId} is Active but has no primary owning slice`,
        file: relGsdRootFile("REQUIREMENTS"),
        fixable: false,
      });
    }

    if (status === "blocked" && !notes) {
      issues.push({
        severity: "warning",
        code: "blocked_requirement_missing_reason",
        scope: "project",
        unitId: requirementId,
        message: `${requirementId} is Blocked but has no reason in Notes`,
        file: relGsdRootFile("REQUIREMENTS"),
        fixable: false,
      });
    }
  }

  return issues;
}

// ── Helper: circular dependency detection ──────────────────────────────────
function detectCircularDependencies(slices: RoadmapSliceEntry[]): string[][] {
  const known = new Set(slices.map(s => s.id));
  const adj = new Map<string, string[]>();
  for (const s of slices) adj.set(s.id, s.depends.filter(d => known.has(d)));
  const state = new Map<string, "unvisited" | "visiting" | "done">();
  for (const s of slices) state.set(s.id, "unvisited");
  const cycles: string[][] = [];
  function dfs(id: string, path: string[]): void {
    const st = state.get(id);
    if (st === "done") return;
    if (st === "visiting") { cycles.push([...path.slice(path.indexOf(id)), id]); return; }
    state.set(id, "visiting");
    for (const dep of adj.get(id) ?? []) dfs(dep, [...path, id]);
    state.set(id, "done");
  }
  for (const s of slices) if (state.get(s.id) === "unvisited") dfs(s.id, []);
  return cycles;
}

export async function checkGsdStateHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  options: {
    fix: boolean;
    shouldFix: (code: DoctorIssueCode) => boolean;
    scope?: string;
  },
): Promise<void> {
  const { fix, shouldFix, scope } = options;
  const requirementsPath = resolveGsdRootFile(basePath, "REQUIREMENTS");
  const requirementsContent = await loadFile(requirementsPath);
  issues.push(...auditRequirements(requirementsContent));

  const state = await deriveState(basePath);

  // Provider / auth health checks — only relevant when there is active work to dispatch.
  // Skipped for idle projects (no active milestone) to avoid noise in environments
  // where CI/test runners have no API key configured.
  if (state.activeMilestone) {
    try {
      const providerResults = runProviderChecks();
      for (const result of providerResults) {
        if (!result.required) continue;
        if (result.status === "error") {
          issues.push({
            severity: "warning",
            code: "provider_key_missing",
            scope: "project",
            unitId: "project",
            message: result.message + (result.detail ? ` — ${result.detail}` : ""),
            fixable: false,
          });
        } else if (result.status === "warning") {
          issues.push({
            severity: "warning",
            code: "provider_key_backedoff",
            scope: "project",
            unitId: "project",
            message: result.message + (result.detail ? ` — ${result.detail}` : ""),
            fixable: false,
          });
        }
      }
    } catch {
      // Non-fatal — provider check failure should not block other checks
    }
  }

  // When DB is unavailable, state.registry is empty. Fall back to a direct
  // filesystem scan so the doctor can still report issues (e.g. missing ROADMAP)
  // for milestone dirs that exist on disk.
  const milestoneEntries: Array<{ id: string; title: string }> =
    state.registry.length > 0
      ? state.registry
      : findMilestoneIds(basePath).map(id => ({ id, title: id }));

  for (const milestone of milestoneEntries) {
    const milestoneId = milestone.id;
    const milestonePath = resolveMilestonePath(basePath, milestoneId);

    // Validate milestone title for delimiter characters that break state documents.
    const milestoneTitleIssue = validateTitle(milestone.title);
    if (milestoneTitleIssue) {
      const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
      let wasFixed = false;
      if (shouldFix("delimiter_in_title") && roadmapFile) {
        try {
          const raw = readFileSync(roadmapFile, "utf-8");
          // Replace em/en dashes with " - " in the H1 title line only
          const sanitized = raw.replace(/^(# .*)$/m, (line) =>
            line.replace(/[\u2014\u2013]/g, "-"),
          );
          if (sanitized !== raw) {
            await saveFile(roadmapFile, sanitized);
            fixesApplied.push(`sanitized delimiter characters in ${milestoneId} title`);
            wasFixed = true;
          }
        } catch { /* non-fatal — report the warning below */ }
      }
      if (!wasFixed) {
        issues.push({
          severity: "warning",
          code: "delimiter_in_title",
          scope: "milestone",
          unitId: milestoneId,
          message: `Milestone ${milestoneId} ${milestoneTitleIssue}. Rename the milestone to remove these characters to prevent state corruption.`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: true,
        });
      }
    }

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
    if (!roadmapContent) {
      // #1634: a missing ROADMAP with intact DB planning data is projection
      // drift, not data loss — the DB is the authority. Repair by re-rendering,
      // sharing the same predicate and repair as the roadmap-missing drift
      // handler so doctor and reconciliation agree on what is fixable.
      const dbMilestone = getMilestone(milestoneId);
      const { isRoadmapRenderable } = await import("./state-reconciliation/drift/roadmap.js");
      const renderable = dbMilestone !== null && isRoadmapRenderable(dbMilestone);
      if (renderable && fix && shouldFix("missing_roadmap")) {
        try {
          const { renderRoadmapFromDb } = await import("./markdown-renderer.js");
          const rendered = await renderRoadmapFromDb(basePath, milestoneId);
          if (!("skipped" in rendered)) {
            fixesApplied.push(`re-rendered missing ROADMAP.md for ${milestoneId} from the DB`);
            continue;
          }
        } catch { /* non-fatal — report the issue below */ }
      }
      issues.push({
        severity: "error",
        code: "missing_roadmap",
        scope: "milestone",
        unitId: milestoneId,
        message: renderable
          ? `Milestone ${milestoneId} is missing its ROADMAP.md file. Its plan is intact in the DB — run /gsd sync (or gsd doctor --fix) to re-render it.`
          : `Milestone ${milestoneId} is missing its ROADMAP.md file.`,
        fixable: renderable,
      });
      continue;
    }
    if (!milestonePath) continue;

    // Slices come from the DB (ADR-017): the roadmap projection is display only.
    type NormSlice = RoadmapSliceEntry & { pending?: boolean; skipped?: boolean };
    const slices: NormSlice[] = getMilestoneSlices(milestoneId).map(s => ({
      id: s.id,
      title: s.title,
      done: isClosedStatus(s.status),
      pending: s.status === "pending",
      skipped: s.status === "skipped",
      risk: (s.risk || "medium") as RoadmapSliceEntry["risk"],
      depends: s.depends,
      demo: s.demo,
    }));
    // Wrap in Roadmap-compatible shape for detectCircularDependencies
    const roadmap = { slices };

    // ── Circular dependency detection ──────────────────────────────────────
    for (const cycle of detectCircularDependencies(roadmap.slices)) {
      issues.push({
        severity: "error",
        code: "circular_slice_dependency",
        scope: "milestone",
        unitId: milestoneId,
        message: `Circular dependency detected: ${cycle.join(" → ")}`,
        file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
        fixable: false,
      });
    }

    // ── Orphaned slice directories ─────────────────────────────────────────
    try {
      const slicesDir = join(milestonePath, "slices");
      if (existsSync(slicesDir)) {
        const knownSliceIds = new Set(roadmap.slices.map(s => s.id));
        for (const entry of readdirSync(slicesDir)) {
          try {
            if (!lstatSync(join(slicesDir, entry)).isDirectory()) continue;
          } catch { continue; }
          if (entry === "parallel-research") continue;
          if (!knownSliceIds.has(entry)) {
            const quarantineExample = `.gsd/quarantine/milestones/${milestoneId}/slices/${entry}-manual-review`;
            issues.push({
              severity: "warning",
              code: "orphaned_slice_directory",
              scope: "milestone",
              unitId: milestoneId,
              message:
                `Directory "${entry}" exists in ${milestoneId}/slices/ but is not referenced in the roadmap or DB. ` +
                `Review it; if stale, move or delete it. To preserve it, move it under ${quarantineExample}. ` +
                "If it contains work to keep, copy or merge that content into a DB-backed slice before resuming.",
              file: `${relMilestonePath(basePath, milestoneId)}/slices/${entry}`,
              fixable: false,
            });
          }
        }
      }
    } catch { /* non-fatal */ }

    for (const slice of roadmap.slices) {
      const unitId = `${milestoneId}/${slice.id}`;
      if (scope && !matchesScope(unitId, scope) && scope !== milestoneId) continue;

      // Validate slice title for delimiter characters.
      const sliceTitleIssue = validateTitle(slice.title);
      if (sliceTitleIssue) {
        // Slice titles live inside the roadmap H1/checkbox lines — the milestone-level
        // fix above already sanitizes the roadmap file. For slices we only report, because
        // the title comes from the checkbox text and requires careful regex to fix safely.
        issues.push({
          severity: "warning",
          code: "delimiter_in_title",
          scope: "slice",
          unitId,
          message: `Slice ${unitId} ${sliceTitleIssue}. Rename the slice to remove these characters to prevent state corruption.`,
          file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
          fixable: false,
        });
      }

      // Check for unresolvable dependency IDs
      const knownSliceIds = new Set(roadmap.slices.map(s => s.id));
      for (const dep of slice.depends) {
        if (!knownSliceIds.has(dep)) {
          issues.push({
            severity: "warning",
            code: "unresolvable_dependency",
            scope: "slice",
            unitId,
            message: `Slice ${unitId} depends on "${dep}" which is not a slice ID in this roadmap. This permanently blocks the slice. Use comma-separated IDs: \`depends:[S01,S02]\``,
            file: relMilestoneFile(basePath, milestoneId, "ROADMAP"),
            fixable: false,
          });
        }
      }

      const slicePath = resolveSlicePath(basePath, milestoneId, slice.id);
      if (!slicePath) {
        // Pending slices haven't been planned yet — directories are created
        // lazily by ensurePreconditions() at dispatch time. Skipped slices are
        // intentionally allowed to remain summary-less and directory-less.
        if (slice.pending || slice.skipped) continue;
        const expectedPath = relSlicePath(basePath, milestoneId, slice.id);
        issues.push({
          severity: slice.done ? "warning" : "error",
          code: "missing_slice_dir",
          scope: "slice",
          unitId,
          message: slice.done
            ? `Missing slice directory for ${unitId} (slice is complete — cosmetic only)`
            : `Missing slice directory for ${unitId}`,
          file: expectedPath,
          fixable: true,
        });
        if (fix) {
          const absoluteSliceDir = join(milestonePath, "slices", slice.id);
          mkdirSync(absoluteSliceDir, { recursive: true });
          fixesApplied.push(`created ${absoluteSliceDir}`);
        }
        continue;
      }

      const tasksDir = resolveTasksDir(basePath, milestoneId, slice.id);
      // True when resolveSlicePath() fell back to the phase dir (flat-phase, no
      // slices/<SID>/ subdir), which makes tasksDir a single directory shared by
      // every slice in the milestone rather than this slice's own.
      const tasksDirIsShared = !!slicePath && !!milestonePath && slicePath === milestonePath;
      if (!tasksDir) {
        // Pending slices haven't been planned yet — tasks/ is created on demand.
        // Skipped slices may legitimately never create tasks/.
        if (slice.pending || slice.skipped) continue;
        // Flat-phase: tasks are embedded in plan files; no tasks/ subdir expected.
        if (!existsSync(legacyMilestonesDir(basePath))) continue;
        issues.push({
          severity: slice.done ? "warning" : "error",
          code: "missing_tasks_dir",
          scope: "slice",
          unitId,
          message: slice.done
            ? `Missing tasks directory for ${unitId} (slice is complete \u2014 cosmetic only)`
            : `Missing tasks directory for ${unitId}`,
          file: relSlicePath(basePath, milestoneId, slice.id),
          fixable: true,
        });
        if (fix) {
          mkdirSync(join(slicePath, "tasks"), { recursive: true });
          fixesApplied.push(`created ${join(slicePath, "tasks")}`);
        }
      }

      // Plan tasks come from the DB (ADR-017): the PLAN projection is display only.
      let plan: { tasks: Array<{ id: string; done: boolean; title: string; estimate?: string }> } | null = null;
      const dbTasks = getSliceTasks(milestoneId, slice.id);
      if (dbTasks.length > 0) {
        plan = { tasks: dbTasks.map(t => ({ id: t.id, done: t.status === "complete" || t.status === "done", title: t.title, estimate: t.estimate || undefined })) };
      }
      if (!plan) {
        if (!slice.done) {
          issues.push({
            severity: "warning",
            code: "missing_slice_plan",
            scope: "slice",
            unitId,
            message: `Slice ${unitId} has no plan file`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"),
            fixable: false,
          });
        }
        continue;
      }

      // ── Duplicate task IDs ───────────────────────────────────────────────
      const taskIdCounts = new Map<string, number>();
      for (const task of plan.tasks) taskIdCounts.set(task.id, (taskIdCounts.get(task.id) ?? 0) + 1);
      for (const [taskId, count] of taskIdCounts) {
        if (count > 1) {
          issues.push({ severity: "error", code: "duplicate_task_id", scope: "slice", unitId,
            message: `Task ID "${taskId}" appears ${count} times in ${slice.id}-PLAN.md — duplicate IDs cause dispatch failures`,
            file: relSliceFile(basePath, milestoneId, slice.id, "PLAN"), fixable: false });
        }
      }

      // ── Task files on disk not in plan ────────────────────────────────────
      try {
        if (tasksDir) {
          const planTaskIds = new Set(plan.tasks.map(t => t.id));
          for (const f of readdirSync(tasksDir)) {
            if (!f.endsWith("-SUMMARY.md")) continue;
            const diskTaskId = f.replace(/-SUMMARY\.md$/, "");
            // In flat-phase layouts resolveSlicePath() falls back to the phase
            // dir when no slices/<SID>/ subdir exists, so resolveTasksDir()
            // hands back ONE shared <phase>/tasks/ for every slice. Its listing
            // then holds every slice's task summaries, and comparing all of them
            // against a single slice's plan reports each foreign summary as
            // missing from every slice that does not own it.
            //
            // Only attribute a summary to this slice when we can actually prove
            // ownership. A slice-qualified id ("S06.T02") names its owner. An
            // unqualified id ("T02") in a shared dir is unattributable from the
            // filename alone, so skip it rather than guess — a missed finding is
            // better than one false positive per sibling slice. In a genuine
            // per-slice tasks/ dir every file does belong to this slice, so the
            // original unfiltered behavior is preserved there.
            if (tasksDirIsShared) {
              const dot = diskTaskId.indexOf(".");
              if (dot <= 0 || diskTaskId.slice(0, dot) !== slice.id) continue;
            }
            if (!planTaskIds.has(diskTaskId)) {
              issues.push({ severity: "info", code: "task_file_not_in_plan", scope: "slice", unitId,
                message: `Task summary "${f}" exists on disk but "${diskTaskId}" is not in ${slice.id}-PLAN.md`,
                file: relTaskFile(basePath, milestoneId, slice.id, diskTaskId, "SUMMARY"), fixable: false });
            }
          }
        }
      } catch { /* non-fatal */ }

      let allTasksDone = plan.tasks.length > 0;
      for (const task of plan.tasks) {
        const taskUnitId = `${unitId}/${task.id}`;
        const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
        const hasSummary = !!(summaryPath && await loadFile(summaryPath));

        // Must-have verification
        if (task.done && hasSummary) {
          const taskPlanPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "PLAN");
          if (taskPlanPath) {
            const taskPlanContent = await loadFile(taskPlanPath);
            if (taskPlanContent) {
              const mustHaves = parseTaskPlanMustHaves(taskPlanContent);
              if (mustHaves.length > 0) {
                const summaryContent = await loadFile(summaryPath!);
                const mentionedCount = summaryContent
                  ? countMustHavesMentionedInSummary(mustHaves, summaryContent)
                  : 0;
                if (mentionedCount < mustHaves.length) {
                  issues.push({
                    severity: "warning",
                    code: "task_done_must_haves_not_verified",
                    scope: "task",
                    unitId: taskUnitId,
                    message: `Task ${task.id} has ${mustHaves.length} must-haves but summary addresses only ${mentionedCount}`,
                    file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"),
                    fixable: false,
                  });
                }
              }
            }
          }
        }

        // ── Future timestamp check ─────────────────────────────────────
        if (task.done && hasSummary && summaryPath) {
          try {
            const rawSummary = await loadFile(summaryPath);
            const m = rawSummary?.match(/^completed_at:\s*(.+)$/m);
            if (m) {
              const ts = new Date(m[1].trim());
              if (!isNaN(ts.getTime()) && ts.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
                issues.push({ severity: "warning", code: "future_timestamp", scope: "task", unitId: taskUnitId,
                  message: `Task ${task.id} has completed_at "${m[1].trim()}" which is more than 24h in the future`,
                  file: relTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY"), fixable: false });
              }
            }
          } catch { /* non-fatal */ }
        }

        allTasksDone = allTasksDone && task.done;
      }

      // Blocker-without-replan detection
      // Skip when all tasks are done — the blocker was implicitly resolved
      // within the task and the slice is not stuck (#3105 Bug 2).
      const replanPath = resolveSliceFile(basePath, milestoneId, slice.id, "REPLAN");
      if (!replanPath && !allTasksDone) {
        for (const task of plan.tasks) {
          if (!task.done) continue;
          const summaryPath = resolveTaskFile(basePath, milestoneId, slice.id, task.id, "SUMMARY");
          if (!summaryPath) continue;
          const summaryContent = await loadFile(summaryPath);
          if (!summaryContent) continue;
          const summary = parseSummary(summaryContent);
          if (summary.frontmatter.blocker_discovered) {
            issues.push({
              severity: "warning",
              code: "blocker_discovered_no_replan",
              scope: "slice",
              unitId,
              message: `Task ${task.id} reported blocker_discovered but no REPLAN.md exists for ${slice.id} \u2014 slice may be stuck`,
              file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"),
              fixable: false,
            });
            break;
          }
        }
      }

      // ── Stale REPLAN: exists but all tasks done ────────────────────────
      if (replanPath && allTasksDone) {
        issues.push({ severity: "info", code: "stale_replan_file", scope: "slice", unitId,
          message: `${slice.id} has a REPLAN.md but all tasks are done — REPLAN.md may be stale`,
          file: relSliceFile(basePath, milestoneId, slice.id, "REPLAN"), fixable: false });
      }

    }

    // Milestone-level check: all slices done but no validation file
    const milestoneComplete = roadmap.slices.length > 0 && roadmap.slices.every(s => s.done);
    if (milestoneComplete && !resolveMilestoneFile(basePath, milestoneId, "VALIDATION") && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "info",
        code: "all_slices_done_missing_milestone_validation",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but the milestone VALIDATION.md is missing \u2014 milestone is in validating-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "VALIDATION"),
        fixable: false,
      });
    }

    // Milestone-level check: all slices done but no milestone summary
    if (milestoneComplete && !resolveMilestoneFile(basePath, milestoneId, "SUMMARY")) {
      issues.push({
        severity: "warning",
        code: "all_slices_done_missing_milestone_summary",
        scope: "milestone",
        unitId: milestoneId,
        message: `All slices are done but ${milestoneId}-SUMMARY.md is missing \u2014 milestone is stuck in completing-milestone phase`,
        file: relMilestoneFile(basePath, milestoneId, "SUMMARY"),
        fixable: false,
      });
    }
  }
}
