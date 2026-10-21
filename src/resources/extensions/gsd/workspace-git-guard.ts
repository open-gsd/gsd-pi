// Project/App: gsd-pi
// File Purpose: Dispatcher guard for workspace git conflict preflight.

import { ensureWorkspaceGitReady } from "./workspace-git-preflight.js";

function formatCommandLabel(attemptedCommand: string): string {
  const trimmed = attemptedCommand.trim();
  return trimmed ? `/gsd ${trimmed}` : "/gsd";
}

export function isWorkspaceGitAllowedCommand(trimmed: string): boolean {
  const command = trimmed.trim();
  if (!command) return false;

  const [name, subcommand] = command.split(/\s+/, 2);
  if (name === "doctor") return true;
  if (name === "forensics") return true;
  if (name === "recover") return true;
  if (name === "closeout" || command.startsWith("closeout")) return true;
  if (name === "dispatch") {
    return subcommand === "complete" || subcommand === "complete-milestone";
  }
  return false;
}

export async function getWorkspaceGitBlockMessageForBase(
  base: string,
  attemptedCommand = "",
): Promise<string | null> {
  if (isWorkspaceGitAllowedCommand(attemptedCommand)) {
    const ready = await ensureWorkspaceGitReady(base);
    if (ready.ok) return null;
    // Allowlisted commands still heal; only block when unrecoverable probe fails.
    if (ready.severity === "unrecoverable") {
      return [
        `${formatCommandLabel(attemptedCommand)} cannot run because Git state could not be verified.`,
        "",
        ready.reason,
      ].join("\n");
    }
    return null;
  }

  const ready = await ensureWorkspaceGitReady(base);
  if (ready.ok) return null;

  return [
    `${formatCommandLabel(attemptedCommand)} is blocked until Git conflicts are resolved.`,
    "",
    ready.reason,
  ].join("\n");
}
