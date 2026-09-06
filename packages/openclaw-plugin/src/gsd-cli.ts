/**
 * Read seam to GSD: `gsd read <kind> --json --project <dir>`.
 *
 * The envelope is versioned (`integration_version`), so the plugin asserts the
 * version it understands instead of parsing whatever came back.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, tail } from "./redact.js";
import type { ProgressData } from "./types.js";

export const SUPPORTED_INTEGRATION_VERSION = 1;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

const READ_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;

export const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = redactSecrets(tail(String(stderr ?? ""), STDERR_TAIL_BYTES)).trim();
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES") {
            const problem = code === "EACCES" ? "is not executable" : "not found";
            reject(new Error(`gsd CLI ${problem} at "${file}"; set plugins.entries.open-gsd-openclaw.config.cliPath`));
            return;
          }
          reject(new Error(detail || error.message));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** A directory is a GSD project when it carries `.gsd/` (or the legacy `.planning/`). */
export function isGsdProject(dir: string): boolean {
  for (const marker of [".gsd", ".planning"]) {
    const candidate = join(dir, marker);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return true;
    } catch {
      // unreadable marker counts as absent
    }
  }
  return false;
}

export class GsdCli {
  constructor(
    private readonly cliPath: string,
    private readonly exec: ExecFn = defaultExec,
  ) {}

  async readProgress(projectDir: string): Promise<ProgressData> {
    const { stdout } = await this.exec(this.cliPath, ["read", "progress", "--json", "--project", projectDir]);
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new Error("gsd read progress returned non-JSON output");
    }
    if (!envelope || typeof envelope !== "object") {
      throw new Error("gsd read progress returned an empty envelope");
    }
    const record = envelope as { integration_version?: unknown; data?: unknown };
    if (record.integration_version !== SUPPORTED_INTEGRATION_VERSION) {
      throw new Error(
        `unsupported gsd read envelope version ${String(record.integration_version)} (expected ${SUPPORTED_INTEGRATION_VERSION}); upgrade the plugin or gsd`,
      );
    }
    if (!record.data || typeof record.data !== "object") {
      throw new Error("gsd read progress envelope has no data");
    }
    return record.data as ProgressData;
  }
}
