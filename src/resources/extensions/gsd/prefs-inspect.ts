/**
 * Read-only effective-preferences inspection (#2397).
 *
 * This module is a projection over the existing loaders and validator — it
 * never writes preferences, never invents defaults, and deliberately lists
 * unknown keys (flagged) instead of silently hiding them. Provenance is
 * computed per top-level key by comparing the separately-loaded global and
 * project files: project wins over global; absent from both reads as unset
 * (no fabricated default values — MODE_DEFAULTS application stays inside the
 * loader).
 */

import {
  KNOWN_PREFERENCE_KEYS,
  type PreferenceDiagnostic,
} from "./preferences-types.js";
import {
  getGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
} from "./preferences.js";

export interface EffectivePreferenceEntry {
  key: string;
  /** Where the effective value comes from: project overrides global. */
  source: "project" | "global" | "unset";
  /** Effective value; undefined when unset in both files. */
  value?: unknown;
  projectValue?: unknown;
  globalValue?: unknown;
}

export interface PreferencesFileStatus {
  scope: "global" | "project";
  path: string;
  present: boolean;
}

export interface PreferencesInspection {
  entries: EffectivePreferenceEntry[];
  /**
   * Keys present in a file but not in KNOWN_PREFERENCE_KEYS. The loaders drop
   * unknown keys from their output (keeping only a diagnostic), so these have
   * no value to show — naming them here still makes the omission visible.
   */
  unknownKeys: Array<{ key: string; scope: "global" | "project" }>;
  /** Per-file diagnostics from the loaders (parse + validation), file order. */
  diagnostics: PreferenceDiagnostic[];
  files: PreferencesFileStatus[];
}

function hasOwn(obj: Record<string, unknown> | undefined, key: string): boolean {
  if (!obj) return false;
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Compact display form of a preference value for the list view: JSON on one
 * line, truncated with an ellipsis. `undefined` renders as "—".
 */
export function formatPreferenceValue(value: unknown, maxLength = 80): string {
  if (value === undefined) return "—";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

/**
 * Build the read-only effective view over both preference files.
 * `basePath` scopes the project file lookup, matching the loaders.
 */
export function inspectPreferences(basePath?: string): PreferencesInspection {
  const global = loadGlobalGSDPreferences();
  const project = loadProjectGSDPreferences(basePath);

  const globalPrefs = global?.preferences as Record<string, unknown> | undefined;
  const projectPrefs = project?.preferences as Record<string, unknown> | undefined;

  const entries: EffectivePreferenceEntry[] = [...KNOWN_PREFERENCE_KEYS]
    .sort()
    .map((key) => {
      const inProject = hasOwn(projectPrefs, key);
      const inGlobal = hasOwn(globalPrefs, key);
      return {
        key,
        source: inProject ? "project" : inGlobal ? "global" : "unset",
        value: inProject ? projectPrefs?.[key] : inGlobal ? globalPrefs?.[key] : undefined,
        projectValue: inProject ? projectPrefs?.[key] : undefined,
        globalValue: inGlobal ? globalPrefs?.[key] : undefined,
      };
    });

  return {
    entries,
    unknownKeys: collectUnknownKeys(inspectionDiagnostics(global, project)),
    diagnostics: inspectionDiagnostics(global, project),
    files: [
      { scope: "global", path: getGlobalGSDPreferencesPath(), present: global !== null },
      { scope: "project", path: getProjectGSDPreferencesPath(basePath), present: project !== null },
    ],
  };
}

function inspectionDiagnostics(
  global: ReturnType<typeof loadGlobalGSDPreferences>,
  project: ReturnType<typeof loadProjectGSDPreferences>,
): PreferenceDiagnostic[] {
  return [...(global?.diagnostics ?? []), ...(project?.diagnostics ?? [])];
}

const UNKNOWN_KEY_MESSAGE = /^unknown preference key "([^"]+)"/;

function collectUnknownKeys(
  diagnostics: PreferenceDiagnostic[],
): Array<{ key: string; scope: "global" | "project" }> {
  const out: Array<{ key: string; scope: "global" | "project" }> = [];
  for (const d of diagnostics) {
    const match = UNKNOWN_KEY_MESSAGE.exec(d.message);
    if (match) out.push({ key: match[1]!, scope: d.scope });
  }
  return out;
}

/**
 * One selectable list line per entry: `key · value · source`, unknown keys
 * flagged. Order is stable (sorted by key) so re-opening the inspect loop
 * never shuffles rows under the cursor.
 */
export function formatInspectLines(inspection: PreferencesInspection, maxLength = 80): string[] {
  return inspection.entries.map((entry) => {
    return `${entry.key} · ${formatPreferenceValue(entry.value, maxLength)} · ${entry.source}`;
  });
}

/**
 * Multi-line detail for one entry: full (untruncated) values per file,
 * provenance, and any diagnostics that mention the key.
 */
export function formatInspectDetail(
  inspection: PreferencesInspection,
  entry: EffectivePreferenceEntry,
): string {
  const lines: string[] = [`key: ${entry.key}`];
  const fileFor = (scope: "global" | "project") => inspection.files.find((f) => f.scope === scope);
  if (entry.projectValue !== undefined) {
    lines.push(`project (${fileFor("project")?.path ?? "?"}): ${formatPreferenceValue(entry.projectValue, 2000)}`);
  }
  if (entry.globalValue !== undefined) {
    lines.push(`global (${fileFor("global")?.path ?? "?"}): ${formatPreferenceValue(entry.globalValue, 2000)}`);
  }
  if (entry.source === "unset") {
    lines.push("not set in either file — the loader's built-in default applies (run the wizard to set it)");
  } else {
    lines.push(`effective source: ${entry.source}`);
  }
  const keyDiagnostics = inspection.diagnostics.filter((d) => d.message.includes(`"${entry.key}"`));
  const otherDiagnostics = inspection.diagnostics.length - keyDiagnostics.length;
  if (keyDiagnostics.length > 0) {
    lines.push("diagnostics:");
    for (const d of keyDiagnostics) {
      lines.push(`  [${d.scope}${d.line !== undefined ? `:${d.line}` : ""}] ${d.severity}: ${d.message}`);
    }
  }
  if (otherDiagnostics > 0) {
    lines.push(`(${otherDiagnostics} other diagnostic${otherDiagnostics > 1 ? "s" : ""} across both files — run /gsd doctor for the full list)`);
  }
  return lines.join("\n");
}
