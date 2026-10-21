// gsd-pi + prefs-wizard-coverage.test.ts - Behavioral coverage for preferences wizard persistence.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCategorySummaries,
  handlePrefsWizard,
  serializePreferencesToFrontmatter,
} from "../commands-prefs-wizard.ts";
import { parsePreferencesMarkdown, validatePreferences } from "../preferences.ts";
import { KNOWN_PREFERENCE_KEYS } from "../preferences-types.ts";

const PREF_SAMPLE_VALUES: Record<string, unknown> = {
  version: 1,
  mode: "team",
  always_use_skills: ["debug-like-expert"],
  prefer_skills: ["typescript-expert"],
  avoid_skills: ["slow-skill"],
  skill_rules: [{ when: "unit:execute-task", use: ["test-writer-fixer"] }],
  custom_instructions: ["Keep changes focused."],
  models: { execution: "openai/gpt-5" },
  thinking: { planning: "xhigh", execution: "low" },
  skill_discovery: "auto",
  skill_staleness_days: 7,
  auto_supervisor: { soft_timeout_minutes: 20, idle_timeout_minutes: 10, hard_timeout_minutes: 30 },
  uat_dispatch: true,
  unique_milestone_ids: true,
  budget_ceiling: 12.5,
  budget_enforcement: "warn",
  context_pause_threshold: 80,
  notifications: {
    enabled: true,
    local_bell: true,
    on_complete: true,
    on_error: true,
    on_budget: true,
    on_milestone: true,
    on_attention: true,
  },
  cmux: { enabled: true },
  remote_questions: { provider: "slack", channel: "C123" },
  git: {
    auto_push: false,
    push_branches: true,
    pre_merge_check: true,
    merge_strategy: "squash",
    isolation: "worktree",
    main_branch: "main",
    absorb_snapshot_commits: true,
  },
  post_unit_hooks: [{ command: "npm test" }],
  pre_dispatch_hooks: [{ command: "npm run lint" }],
  planning_subagent_registry: {
    "custom-planner": { read_only_specialist: true },
  },
  planning_subagents: {
    "plan-milestone": { allowed: ["scout", "planner"] },
    "plan-slice": { allowed: ["scout"] },
  },
  dynamic_routing: { enabled: true },
  disabled_model_providers: ["slow-provider"],
  uok: { enabled: true },
  token_profile: "standard",
  phases: { progressive_planning: true },
  auto_visualize: true,
  auto_report: true,
  parallel: { enabled: true, max_workers: 2 },
  verification_commands: ["npm test"],
  verification_auto_fix: true,
  verification_max_retries: 1,
  verification_timeout_ms: 120000,
  per_unit_cost_cap_usd: 5,
  unit_cost_spike_multiplier: 4,
  search_provider: "web",
  context_selection: "auto",
  widget_mode: "small",
  reactive_execution: { enabled: true },
  gate_evaluation: { enabled: true },
  github: { enabled: true },
  service_tier: "default",
  forensics_dedup: true,
  show_token_cost: true,
  min_request_interval_ms: 250,
  stale_commit_threshold_minutes: 15,
  context_management: { enabled: true },
  tool_call_loop_guard: {
    enabled: true,
    identical_args: { enabled: true, max_consecutive_calls: 4 },
    repeated_tool: { enabled: true, default_cap: 6, repeatable_cap: 15, exempt_tools: ["ctx_execute"] },
  },
  experimental: { rtk: true },
  codebase: { indexing: "auto" },
  slice_parallel: { enabled: true, max_workers: 2 },
  safety_harness: { enabled: true },
  enhanced_verification: true,
  enhanced_verification_pre: true,
  enhanced_verification_post: true,
  enhanced_verification_strict: false,
  discuss_preparation: true,
  discuss_web_research: true,
  discuss_depth: "standard",
  flat_rate_providers: ["openai"],
  language: "en",
  context_window_override: 128000,
  context_mode: { enabled: true },
  copilot_catalog: { refresh_on_session_start: "if_stale", notify_on_changes: true, stale_after_ms: 3_600_000 },
  planning_depth: "deep",
  claude_code_mcp: { per_model: { "claude-haiku": { allowed_servers: ["gsd-workflow"] } } },
  workspace: {
    mode: "parent",
    repositories: {
      frontend: {
        path: "frontend",
        role: "web UI",
        verification: ["npm test"],
      },
    },
  },
  runtime: {
    contract: {
      path: "script/local-runtime",
      entry: "start.sh",
    },
  },
};

test("prefs serializer preserves nested hook on_block objects", () => {
  const frontmatter = serializePreferencesToFrontmatter({
    post_unit_hooks: [{
      name: "plan-review",
      after: ["execute-task"],
      prompt: "write PLAN-REVIEW.md",
      artifact: "PLAN-REVIEW.md",
      criticality: "blocking",
      on_block: { action: "pause" },
    }],
  });

  assert.doesNotMatch(frontmatter, /\[object Object\]/);
  assert.ok(frontmatter.includes("    on_block:\n      action: pause\n"));

  const parsed = parsePreferencesMarkdown(`---\n${frontmatter}---\n`);
  assert.notEqual(parsed, null);

  const { errors, preferences } = validatePreferences(parsed!);
  assert.deepEqual(errors, []);
  assert.deepEqual(preferences.post_unit_hooks?.[0]?.on_block, { action: "pause" });
});

test("prefs serializer correctly indents nested object when it is the first array-item property", () => {
  // on_block is the FIRST property — exercises the first-key-is-object branch
  const frontmatter = serializePreferencesToFrontmatter({
    post_unit_hooks: [{
      on_block: { action: "pause" }, // first property — exercises the first-key-is-object branch
      name: "gate",                  // required fields come after so on_block stays first
      after: ["execute-task"],
      prompt: "review output",
    }],
  });

  assert.doesNotMatch(frontmatter, /\[object Object\]/);
  // Children of on_block must be indented deeper than on_block itself (not siblings)
  assert.ok(
    frontmatter.includes("  - on_block:\n      action: pause\n"),
    `Expected on_block children indented as nested YAML, got:\n${frontmatter}`,
  );
  // Sanity: parse + validate round-trip
  const parsed = parsePreferencesMarkdown(`---\n${frontmatter}---\n`);
  assert.notEqual(parsed, null);
  const { errors, preferences } = validatePreferences(parsed!);
  assert.deepEqual(errors, []);
  assert.deepEqual(preferences.post_unit_hooks?.[0]?.on_block, { action: "pause" });
});

test("prefs wizard save path preserves every known preference key", async () => {
  const missingSamples = [...KNOWN_PREFERENCE_KEYS].filter((key) => !(key in PREF_SAMPLE_VALUES));
  assert.deepEqual(missingSamples, [], "test fixture must cover every known preference key");

  const dir = mkdtempSync(join(tmpdir(), "gsd-prefs-wizard-"));
  const prefsPath = join(dir, "PREFERENCES.md");
  const choices = ["── Save & Exit ──"];
  const ctx = {
    ui: {
      notify() {},
      select: async () => choices.shift(),
    },
    waitForIdle: async () => {},
    reload: async () => {},
  } as any;

  try {
    await handlePrefsWizard(ctx, "project", PREF_SAMPLE_VALUES, { pathOverride: prefsPath });
    const saved = readFileSync(prefsPath, "utf-8");
    const missingPersisted = [...KNOWN_PREFERENCE_KEYS].filter((key) => !saved.includes(`${key}:`));
    assert.deepEqual(missingPersisted, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification wizard prompts for per-unit cost cap and persists it (regression #1121)", async () => {
  // Regression for #1121: the `/gsd prefs` Verification category never prompted for
  // `per_unit_cost_cap_usd`, so the per-unit cost cap could only be set by hand-editing
  // PREFERENCES.md. Drive the wizard into Verification, answer the cap prompt, and assert
  // the prompt exists and the entered value is serialized + round-trips back as a number.
  const dir = mkdtempSync(join(tmpdir(), "gsd-prefs-wizard-"));
  const prefsPath = join(dir, "PREFERENCES.md");

  const inputLabels: string[] = [];
  let topMenuVisits = 0;

  const ctx = {
    ui: {
      notify() {},
      select: async (label: string, options: string[]) => {
        if (label === "GSD Preferences") {
          topMenuVisits += 1;
          if (topMenuVisits === 1) {
            const verification = options.find((o) => o.startsWith("Verification"));
            assert.ok(verification, "wizard menu must offer a Verification category");
            return verification;
          }
          return "── Save & Exit ──";
        }
        // verification_commands string-list sub-menu — leave it untouched
        if (options.includes("Done")) return "Done";
        // boolean/enum prompts within the category — keep the current value
        if (options.includes("(keep current)")) return "(keep current)";
        return options[options.length - 1];
      },
      input: async (label: string) => {
        inputLabels.push(label);
        if (label.includes("Per-unit cost cap")) return "12.5";
        return null; // escape every other numeric/string prompt (no change)
      },
    },
    waitForIdle: async () => {},
    reload: async () => {},
  } as any;

  try {
    await handlePrefsWizard(ctx, "project", {}, { pathOverride: prefsPath });

    // The Verification wizard must actually ask for the per-unit cost cap.
    assert.ok(
      inputLabels.some((l) => l.includes("Per-unit cost cap")),
      `Verification wizard must prompt for the per-unit cost cap; prompts seen:\n${inputLabels.join("\n")}`,
    );

    // The entered value must be serialized to PREFERENCES.md...
    const saved = readFileSync(prefsPath, "utf-8");
    assert.match(saved, /per_unit_cost_cap_usd:\s*12\.5(\s|$)/m);

    // ...and round-trip back through the parser/validator as a number.
    const parsed = parsePreferencesMarkdown(saved);
    assert.notEqual(parsed, null);
    const { errors, preferences } = validatePreferences(parsed!);
    assert.deepEqual(errors, []);
    assert.equal(preferences.per_unit_cost_cap_usd, 12.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("category summaries expose the wizard menu surface for configured prefs", () => {
  const summaries = buildCategorySummaries(PREF_SAMPLE_VALUES);
  assert.deepEqual(
    Object.keys(summaries).sort(),
    [
      "advanced",
      "budget",
      "context",
      "discuss",
      "git",
      "hooks",
      "integrations",
      "mode",
      "models",
      "notifications",
      "parallelism",
      "phases",
      "skills",
      "timeouts",
      "uok",
      "verification",
      "workspace",
    ],
  );
  assert.match(summaries.models, /phase/);
  assert.match(summaries.integrations, /remote: C123/);
  assert.match(summaries.verification, /1 cmd/);
  assert.match(summaries.workspace, /mode: parent/);
  assert.match(summaries.workspace, /1 repo/);
});

test("models wizard offers discovered models for enabled providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-prefs-wizard-"));
  const prefsPath = join(dir, "PREFERENCES.md");
  const choices = [
    "Models",
    "local (2 models)",
    "discovered-model",
    "(keep current)",
    "(keep current)",
    "(keep current)",
    "(keep current)",
    "(keep current)",
    "(keep current)",
    "(keep current)",
  ];
  const ctx = {
    // `getAllWithDiscovered` reads `this._all` so the wizard must call it as a
    // method — invoking a detached reference would lose `this` and throw,
    // mirroring the real ModelRegistry implementation.
    modelRegistry: {
      _all: [
        { provider: "local", id: "baseline-model" },
        { provider: "local", id: "discovered-model" },
        { provider: "disabled", id: "hidden-model" },
      ],
      getAvailable() {
        return [{ provider: "local", id: "baseline-model" }];
      },
      getAllWithDiscovered() {
        return this._all;
      },
    },
    ui: {
      notify() {},
      select: async (label: string, options: string[]) => {
        const choice = choices.shift();
        if (!choice && label === "GSD Preferences") return "── Save & Exit ──";
        if (!choice && options.includes("(keep current)")) return "(keep current)";
        if (!choice && options.includes("Done")) return "Done";
        assert.ok(choice, `Unexpected prompt: ${label}`);
        if (choice === "Models") {
          const modelsOption = options.find((option) => option.startsWith("Models"));
          assert.ok(modelsOption, "Expected Models category option");
          return modelsOption;
        }
        assert.ok(options.includes(choice), `"${choice}" must be offered by "${label}"`);
        assert.ok(!options.includes("hidden-model"), "models from disabled providers must not be offered");
        return choice;
      },
      input: async () => null,
    },
    waitForIdle: async () => {},
    reload: async () => {},
  } as any;

  try {
    await handlePrefsWizard(ctx, "project", {}, { pathOverride: prefsPath });

    assert.equal(choices.length, 0, "Expected all queued wizard choices to be consumed");
    const saved = readFileSync(prefsPath, "utf-8");
    assert.match(saved, /research:\s+local\/discovered-model/);
    assert.doesNotMatch(saved, /hidden-model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace wizard category configures parent mode with a declared repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-prefs-wizard-workspace-"));
  const prefsPath = join(dir, "PREFERENCES.md");
  try {
    // Drive: Workspace → parent mode → Add repository (id=frontend, path=frontend,
    // role=ui, verification=npm test, commit policy auto) → Done → Save & Exit.
    const selects = [
      "Workspace       (single-repo)",       // pick the Workspace category
      "parent",                               // promptEnum: workspace mode
      "Add repository",                       // sub-menu
      "(keep current)",                       // promptEnum: commit policy -> keep auto default
      "Done",                                 // exit repo sub-menu
      "── Save & Exit ──",                    // exit wizard
    ];
    const inputs = [
      "frontend",                             // repository id
      "frontend",                             // repository path
      "ui",                                   // role
      "npm test",                             // verification commands
    ];
    const ctx = {
      ui: {
        notify() {},
        select: async () => selects.shift(),
        input: async () => inputs.shift(),
      },
      waitForIdle: async () => {},
      reload: async () => {},
    } as any;

    await handlePrefsWizard(ctx, "project", {}, { pathOverride: prefsPath });

    const saved = readFileSync(prefsPath, "utf-8");
    assert.match(saved, /mode: parent/);
    assert.match(saved, /frontend:/);
    assert.match(saved, /path: frontend/);
    assert.match(saved, /role: ui/);
    assert.match(saved, /npm test/);
    assert.equal(selects.length, 0, "all queued selects should be consumed");
    assert.equal(inputs.length, 0, "all queued inputs should be consumed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace wizard does not save parent mode when no repository is declared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-prefs-wizard-workspace-empty-"));
  const prefsPath = join(dir, "PREFERENCES.md");
  try {
    // parent mode with no repos added → should warn and not persist workspace.
    const selects = [
      "Workspace       (single-repo)",
      "parent",
      "Done",                                 // add nothing
      "── Save & Exit ──",
    ];
    const ctx = {
      ui: {
        notify() {},
        select: async () => selects.shift(),
        input: async () => "",
      },
      waitForIdle: async () => {},
      reload: async () => {},
    } as any;

    await handlePrefsWizard(ctx, "project", {}, { pathOverride: prefsPath });

    const saved = readFileSync(prefsPath, "utf-8");
    assert.doesNotMatch(saved, /mode: parent/, "parent mode must not persist without a declared repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
