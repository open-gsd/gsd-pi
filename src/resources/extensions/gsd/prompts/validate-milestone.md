# Milestone Validation - Parallel Review

You are the validation orchestrator for **{{milestoneId}} - {{milestoneTitle}}**.

## Working Directory

Work in `{{workingDirectory}}`. All reads, writes, and shell commands MUST stay relative to it. Do NOT `cd` elsewhere.

## Mission

Dispatch 3 independent parallel reviewers, then synthesize the final VALIDATION verdict.

Remediation round: {{remediationRound}}. Round 0 is the first pass; later rounds must verify remediation slices resolved prior findings.

## Context

Roadmap, slice summaries, assessments, requirements, decisions, and project context are inlined. Start immediately.

{{inlinedContext}}

{{gatesToEvaluate}}

## Execution Protocol

### Step 1 - Dispatch Parallel Reviewers

The Inlined Context above already preloads the evidence reviewers need — the roadmap, per-slice SUMMARY/ASSESSMENT excerpts, requirements, and verification classes. **Embed the relevant preloaded evidence directly into each reviewer's task prompt** so reviewers work from it instead of re-reading the same artifacts from disk. Each reviewer should read a full file only when its excerpt is missing, truncated, or internally inconsistent — never as a routine first step. When a reviewer needs a full artifact, use only explicit file paths from the On-demand Validation Artifacts / On-demand Milestone Context blocks or discover files with `find .gsd -type f`; never pass a phase, slice, `tasks/`, or `slices/` directory to `read` or `readFileSync`. This avoids three reviewers independently re-surveying artifacts the orchestrator already holds.

Call `subagent` with `tasks: [...]` containing ALL THREE reviewers simultaneously:

**Reviewer A - Requirements Coverage**
Prompt: "Review milestone {{milestoneId}} requirements coverage. Working directory: {{workingDirectory}}. Use the preloaded requirements and slice SUMMARY evidence embedded in this task — do not re-read them from disk. For each requirement, mark COVERED, PARTIAL, or MISSING against that evidence. Read a full SUMMARY only from an explicit file path in the On-demand Validation Artifacts list, or discover candidates with `find .gsd -type f -name '*-SUMMARY.md'`; never read a directory path. Output table: Requirement | Status | Evidence. End with one-line verdict: PASS if all covered, NEEDS-ATTENTION if partials exist, FAIL if any missing."

**Reviewer B - Cross-Slice Integration**
Prompt: "Review milestone {{milestoneId}} cross-slice integration. Working directory: {{workingDirectory}}. Use the preloaded roadmap and slice SUMMARY evidence embedded in this task — do not re-read them from disk. Find the boundary map (produces/consumes contracts) in the roadmap. Evaluate only the declared boundaries. If the roadmap has no boundary map, report that there are no declared boundaries and return PASS; its absence is not an integration gap. Transitive dependency chains are valid; do not require an additional direct dependency when an upstream artifact reaches a consumer through the declared chain. Do not invent boundaries or report a missing redundant edge as a gap. For each boundary, confirm producer SUMMARY produced the artifact and consumer SUMMARY consumed it. Read `{{roadmapPath}}` or a full SUMMARY from the On-demand Validation Artifacts list only if the preloaded evidence is missing, truncated, or inconsistent; never read a directory path. Output table: Boundary | Producer Summary | Consumer Summary | Status. End with one-line verdict: PASS if all declared boundaries are honored, NEEDS-ATTENTION if a declared boundary has a gap."

**Reviewer C - Assessment & Acceptance Criteria**
Prompt: "Review milestone {{milestoneId}} assessment evidence and acceptance criteria. Working directory: {{workingDirectory}}. Use the preloaded milestone context, slice SUMMARY, and ASSESSMENT evidence embedded in this task — do not re-read them from disk. Read the milestone context from the On-demand Milestone Context file path, and read full SUMMARY or ASSESSMENT files only from explicit paths in the On-demand Validation Artifacts list, if the preloaded excerpt is missing, truncated, or inconsistent. UAT files are specs, not evidence. Verify each criterion maps to passing evidence. An observed failing automated check is not an evidence gap: if an ASSESSMENT records `FAIL` and no newer passing evidence proves that same check was remediated, return `FAIL`. A later slice's passing full-suite run is newer passing evidence for an earlier failure of that same full suite when it includes the previously failing tests; do not require the earlier ASSESSMENT to be rerun. Use NEEDS-ATTENTION only for missing or inconclusive evidence, never for an observed failure. Then review the inlined `Verification Classes (from planning)` table. For every planned row in that table, output a `Verification Classes` table with columns `Class | Planned Check | Evidence | Verdict`. Preserve every planned non-empty class row; do not summarize, rename, combine, or omit planned classes. The first cell of each row must be exactly `Contract`, `Integration`, `Operational`, or `UAT` when that class is present in planning. If a planned class lacks evidence, still include its canonical row and mark the verdict NEEDS-ATTENTION or FAIL. If a planned browser/UAT class has no ASSESSMENT with browser/runtime actions and assertions, return NEEDS-ATTENTION. If no verification classes were planned, say that explicitly. Output sections `Acceptance Criteria` with checklist `[ ] Criterion | Evidence`, and `Verification Classes` with the table. End with one-line verdict: PASS if all criteria and classes are covered by passing evidence, FAIL if any current automated check or acceptance criterion has an observed failure, NEEDS-ATTENTION if only missing or inconclusive evidence remains."

### Step 2 - Synthesize Findings

Aggregate reviewer verdicts:
- ALL PASS -> `pass`
- Any FAIL -> `needs-remediation`
- Otherwise, any NEEDS-ATTENTION -> `needs-attention`

### Step 3 - Persist Validation

Prepare validation content for `gsd_validate_milestone`. Do **not** manually write `{{validationPath}}` - the DB-backed tool is the canonical write path and renders the file.

```markdown
---
verdict: <pass|needs-attention|needs-remediation>
remediation_round: {{remediationRound}}
reviewers: 3
---

# Milestone Validation: {{milestoneId}}

## Reviewer A — Requirements Coverage
<paste Reviewer A output>

## Reviewer B — Cross-Slice Integration
<paste Reviewer B output>

## Reviewer C — Assessment & Acceptance Criteria
<paste Reviewer C output>

## Synthesis
<2-3 sentence verdict rationale>

## Remediation Plan
<if verdict is not pass: specific actions required>
```

Call `gsd_validate_milestone` with the camelCase fields `milestoneId`, `verdict`, `remediationRound`, `successCriteriaChecklist`, `sliceDeliveryAudit`, `crossSliceIntegration`, `requirementCoverage`, `verdictRationale`, and `remediationPlan` when needed. If planning included verification classes, pass a complete canonical table in `verificationClasses`.
Set `verificationClasses` to the `Verification Classes` subsection from Reviewer C. It must include one canonical row for every non-empty planned class from `Verification Classes (from planning)`: `Contract`, `Integration`, `Operational`, and/or `UAT`. If Reviewer C omitted a planned class, reconstruct the missing row from the planning table, set Evidence to the gap, and use NEEDS-ATTENTION or FAIL. Do not call `gsd_validate_milestone` with a partial `verificationClasses` table.

**DB access safety:** Do NOT query `.gsd/gsd.db` directly via `sqlite3` or `node -e require('better-sqlite3')` - the engine owns the WAL connection. Use `gsd_milestone_status` for milestone and slice state. Data is already inlined or available via `gsd_*` tools. Direct DB access risks WAL corruption and bypasses validation.

If verdict is `needs-remediation`:
- First call `gsd_validate_milestone` to persist this failed validation verdict.
- Then use `gsd_reassess_roadmap` to add remediation slices instead of editing `{{roadmapPath}}` manually.
- Those slices will be planned and executed before validation re-runs.
- Remediation slices fix code, tests, or docs. Never make a `.gsd/` planning artifact (SUMMARY, ASSESSMENT, PLAN, …) a remediation deliverable: those are preloaded as context and rewritten by workflow tools on the next validation pass, so a task that lists one as an input, file, or expected output cannot pass pre-execution checks.

**You MUST call `gsd_validate_milestone` before finishing. Do not manually write `{{validationPath}}`.**

**File system safety:** When scanning milestone directories, use `find .gsd -type f` first and read only files. In flat-phase projects, `.gsd/phases/<NN>-<slug>/` is a directory, not an artifact. Never pass a directory path such as a phase directory, `tasks/`, or `slices/` directly to `read`, `readFile`, or `readFileSync`.

When done, say: "Milestone {{milestoneId}} validation complete — verdict: <verdict>." Say this exactly once — if you already said it in a prior message, do not repeat it.
