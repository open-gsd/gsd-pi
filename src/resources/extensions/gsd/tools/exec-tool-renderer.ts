import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@gsd/pi-coding-agent";
import { Text, wrapTextWithAnsi, type Component } from "@gsd/pi-tui";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripVTControlCharacters(value.replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "   ");
}

function purposeFor(args: Record<string, unknown>): string {
  const purpose = safeText(args.purpose).replace(/\s+/g, " ").trim();
  if (purpose) return purpose;
  const runtime = typeof args.runtime === "string" ? args.runtime.trim().toLowerCase() : args.runtime;
  if (runtime === undefined || runtime === null || ["", "bash", "sh", "shell"].includes(runtime as string)) {
    return "Run a Bash script";
  }
  if (["node", "nodejs", "js", "javascript"].includes(runtime as string)) return "Run a Node.js script";
  if (["python", "python3", "py"].includes(runtime as string)) return "Run a Python script";
  return "Run a script";
}

export function renderExecCall(args: unknown, theme: Theme): Component {
  return new Text(theme.fg("muted", theme.italic(purposeFor(record(args)))), 0, 0);
}

function exitStatus(details: Record<string, unknown>): string {
  if (details.aborted === true) return details.force_resolved === true ? "aborted (force-killed)" : "aborted";
  if (details.force_resolved === true) return "timeout (force-killed)";
  if (details.timed_out === true) return "timeout";
  const signal = safeText(details.signal);
  if (signal) return `signal: ${signal}`;
  return typeof details.exit_code === "number" && Number.isFinite(details.exit_code)
    ? String(details.exit_code)
    : "unknown";
}

function numberLabel(value: unknown, unit: string): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${value}${unit}` : "unknown";
}

export function renderExecResult(
  result: unknown,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): Component {
  const payload = record(result);
  const details = record(payload.details);
  const raw = Array.isArray(payload.content)
    ? payload.content.map((block) => {
      const item = record(block);
      return item.type === "text" ? safeText(item.text) : "";
    }).filter(Boolean).join("\n")
    : "";
  const hasDigest = typeof details.digest === "string";
  const warningStart = hasDigest ? -1 : raw.indexOf("--- warning ---");
  const legacyWarningStart = hasDigest ? -1 : raw.indexOf("The command ran, but the host did not record this run");
  const warningIndex = warningStart >= 0 ? warningStart : legacyWarningStart;
  const rawBody = warningIndex >= 0 ? raw.slice(0, warningIndex).trimEnd() : raw;
  const rawWarning = warningIndex >= 0 ? raw.slice(warningIndex) : "";
  const warning = typeof details.run_not_recorded === "string"
    ? `Warning: The command ran, but the host did not record this run: ${safeText(details.run_not_recorded)}. ` +
      "This run is not verification or UAT evidence. Do not run the command again only to get the output."
    : rawWarning;
  const structured = typeof details.id === "string" && typeof details.runtime === "string";
  const digestMarker = "--- digest ---\n";
  const digestIndex = rawBody.indexOf(digestMarker);
  const preview = typeof details.digest === "string"
    ? safeText(details.digest)
    : structured && digestIndex >= 0 ? rawBody.slice(digestIndex + digestMarker.length) : rawBody;
  const before: string[] = [];
  const after: string[] = [];
  if (structured) {
    before.push(theme.fg("muted", theme.italic(purposeFor(details))));
    before.push(
      `Run ${safeText(details.id)} · runtime: ${safeText(details.runtime)} · exit: ${exitStatus(details)} · ` +
      `duration: ${numberLabel(details.duration_ms, "ms")}`,
      theme.fg("muted", "Output preview (digest; not the full logs):"),
    );
    for (const stream of ["stdout", "stderr"] as const) {
      const bytes = details[`${stream}_bytes`];
      const annotations = [
        `${numberLabel(bytes, "B")} captured`,
        ...(details[`${stream}_truncated`] === true ? ["truncated on disk"] : []),
        ...(bytes === 0 ? ["empty"] : []),
      ].join("; ");
      after.push(
        `${stream} — ${stream === "stdout" ? "standard output (command results)" : "standard error (diagnostics; not necessarily a failure)"}: ${annotations}`,
        `${stream} log: ${safeText(details[`${stream}_path`]) || "(path unavailable)"}`,
      );
    }
    after.push(`Metadata: ${safeText(details.meta_path) || "(path unavailable)"}`);
  }
  if (warning) after.push(theme.fg("warning", warning));

  // Cap after wrapping: a single long digest line can occupy many terminal rows.
  return {
    invalidate() {},
    render(width: number): string[] {
      const columns = Math.max(1, width);
      const wrapped = wrapTextWithAnsi(preview || "(no output preview)", columns);
      const cap = options?.expanded ? 20 : 6;
      const visible = wrapped.slice(0, cap);
      if (wrapped.length > cap) {
        visible.push(theme.fg("muted", `… ${wrapped.length - cap} preview rows hidden from display.` +
          (structured ? " Read the stdout/stderr log paths below for captured output." : "")));
      }
      return new Text([...before, ...visible, ...after].join("\n"), 0, 0).render(columns);
    },
  };
}
