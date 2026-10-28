// Project/App: gsd-pi
// File Purpose: Registers Context Mode execution tools.
// gsd-pi — Exec (context-mode) tool registration.
//
// Exposes the Context Mode runtime tools in-process. Default-on; opt out with
// `context_mode.enabled: false` in preferences.

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { resolveCtxCwd } from "./dynamic-tools.js";
import { renderExecCall, renderExecResult, renderUatExecCall } from "../tools/exec-tool-renderer.js";


async function loadContextModePreferences(baseDir: string) {
  const [{ loadEffectiveGSDPreferences }, { logWarning }] = await Promise.all([
    import("../preferences.js"),
    import("../workflow-logger.js"),
  ]);
  try {
    return loadEffectiveGSDPreferences(baseDir)?.preferences ?? null;
  } catch (err) {
    logWarning("tool", `Context Mode tool could not load preferences: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function registerExecTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gsd_uat_exec",
    label: "UAT Exec",
    description:
      "Run a UAT-scoped bash/node/python check with milestone/slice/check metadata. " +
      "Uses the same capped .gsd/exec evidence store as gsd_exec, but rejects commands that mutate dependencies, git state, credentials, or destructive files.",
    promptSnippet: "Run one UAT check and save typed evidence under .gsd/exec",
    promptGuidelines: [
      "Use gsd_uat_exec for each automated UAT check.",
      "Every PASS/FAIL check saved by gsd_uat_result_save must reference objective evidence from this tool or another approved GSD evidence path.",
      "Do not install packages, mutate git state, edit source files, or dump credentials during UAT.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      checkId: Type.String({ description: "Stable check ID from the UAT spec (e.g. UAT-01)" }),
      intent: Type.String({
        description:
          "UAT command intent. Use one canonical value: uat-artifact-check, uat-runtime-check, " +
          "uat-browser-check, uat-service-start, or uat-log-inspection. Short aliases such as artifact, " +
          "runtime, browser, service-start, and log-inspection are accepted.",
      }),
      runtime: Type.Optional(
        Type.String({
          description:
            "Optional interpreter. Defaults to bash. Supported: bash, node, python; sh/shell, js/nodejs, and py/python3 aliases are accepted.",
        }),
      ),
      script: Type.Optional(Type.String({ description: "Script body. Keep output small (log the finding, not the data)." })),
      command: Type.Optional(Type.String({ description: "Alias for script; defaults to bash when runtime is omitted." })),
      cmd: Type.Optional(Type.String({ description: "Short alias for script." })),
      code: Type.Optional(Type.String({ description: "Alias for script, useful for node/python snippets." })),
      expected: Type.Optional(Type.String({ description: "Expected outcome for this UAT check." })),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Per-invocation timeout (ms). Capped at 3600000 (1 hour). Default from preferences.",
          minimum: 1_000,
          maximum: 3_600_000,
        }),
      ),
    }),
    renderCall(args: any, theme: any, context: any) {
      return renderUatExecCall(args, theme, context);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      return renderExecResult(result, options, theme, context);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeUatExec } = await import("../tools/exec-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeUatExec(params as Parameters<typeof executeUatExec>[0], {
        baseDir,
        preferences: await loadContextModePreferences(baseDir),
        signal: _signal,
      });
    },
  });

  pi.registerTool({
    name: "gsd_exec",
    label: "Exec (Sandboxed)",
    description:
      "Run a short script (bash/node/python) in a subprocess. Capped stdout/stderr and metadata persist to " +
      ".gsd/exec/<id>.{stdout,stderr,meta.json}; only a short digest returns in context. Use " +
      "this instead of reading many files or emitting large tool outputs — e.g. have the script " +
      "count/grep/summarize and log the finding. Enabled by default; opt out via " +
      "preferences.context_mode.enabled=false.",
    promptSnippet:
      "Run a bash/node/python script in a sandbox; capped output is saved to disk and only a digest returns",
    promptGuidelines: [
      "Include a concise English purpose describing why the script is being run; the UI displays it instead of the script.",
      "Prefer gsd_exec for analyses that would otherwise read >3 files or produce large tool output.",
      "Write scripts that log the finding (counts, matches, summaries) rather than raw dumps.",
      "The digest is the last ~300 chars of stdout — size your log output accordingly.",
      "Need persisted output? Read the stdout_path returned in details (file on local disk).",
    ],
    parameters: Type.Object({
      runtime: Type.Optional(
        Type.String({
          description:
            "Optional interpreter. Defaults to bash. Supported: bash, node, python; sh/shell, js/nodejs, and py/python3 aliases are accepted.",
        }),
      ),
      script: Type.Optional(Type.String({ description: "Script body. Keep output small (log the finding, not the data)." })),
      command: Type.Optional(Type.String({ description: "Alias for script; defaults to bash when runtime is omitted." })),
      cmd: Type.Optional(Type.String({ description: "Short alias for script." })),
      code: Type.Optional(Type.String({ description: "Alias for script, useful for node/python snippets." })),
      purpose: Type.Optional(
        Type.String({
          description:
            "Short label shown in the UI and recorded in meta.json. Start with an action verb and name the target — " +
            'e.g. "count failing tests", "grep API routes". Avoid generic labels like "verify": workload ' +
            "classification also reads this field.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Per-invocation timeout (ms). Capped at 3600000 (1 hour). Default from preferences.",
          minimum: 1_000,
          maximum: 3_600_000,
        }),
      ),
    }),
    renderCall(args: any, theme: any, context: any) {
      return renderExecCall("Exec (Sandboxed)", args, theme, context);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      return renderExecResult(result, options, theme, context);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeGsdExec } = await import("../tools/exec-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeGsdExec(params as Parameters<typeof executeGsdExec>[0], {
        baseDir,
        preferences: await loadContextModePreferences(baseDir),
        signal: _signal,
        // In-process only (#2982): this registration may run a Task's Verify
        // command under the verification gate's own invocation when the
        // opt-in preference is set. The workflow MCP server's registration
        // never passes this, so its calls keep the sandboxed allowlist.
        verificationRunContract: true,
      });
    },
  });

  pi.registerTool({
    name: "gsd_exec_search",
    label: "Search gsd_exec History",
    description:
      "List prior gsd_exec runs (most recent first) from .gsd/exec/*.meta.json. Useful for " +
      "rediscovering the stdout_path of an earlier run without re-executing it. Read-only.",
    promptSnippet: "Search prior gsd_exec runs by substring, runtime, or failing-only filter",
    promptGuidelines: [
      "Use this before re-running an expensive analysis — the prior run's stdout file may still answer.",
      "The preview shows the trailing ~300 chars of stdout; read stdout_path for persisted output.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring matched against id and purpose (case-insensitive)." })),
      runtime: Type.Optional(
        Type.String({
          description: "Restrict to one runtime: bash, node, or python.",
        }),
      ),
      failing_only: Type.Optional(Type.Boolean({ description: "Only non-zero exit codes and timeouts." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20, cap 200)", minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeExecSearch } = await import("../tools/exec-search-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeExecSearch(params as Parameters<typeof executeExecSearch>[0], {
        baseDir,
        preferences: await loadContextModePreferences(baseDir),
      });
    },
  });

  pi.registerTool({
    name: "gsd_resume",
    label: "Resume (Read Snapshot)",
    description:
      "Return the contents of .gsd/last-snapshot.md — a ≤2 KB digest of top memories, recent " +
      "gsd_exec runs, and active context, written automatically on session_before_compact. Use " +
      "this after compaction or session resume to re-orient quickly.",
    promptSnippet: "Read the pre-compaction snapshot to re-orient after context loss",
    promptGuidelines: [
      "Call this right after a session resumes if you feel you've lost durable context.",
      "The snapshot is a summary — use memory_query or gsd_exec_search for detail.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { executeResume } = await import("../tools/resume-tool.js");
      const baseDir = resolveCtxCwd(_ctx);
      return executeResume(params as Parameters<typeof executeResume>[0], {
        baseDir,
        preferences: await loadContextModePreferences(baseDir),
      });
    },
  });
}
