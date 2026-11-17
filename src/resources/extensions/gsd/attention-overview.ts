// Project/App: gsd-pi
// File Purpose: Production entry for the native attention overview (#2932). Wires the
// existing read-only SQLite seam to the shared controller; no mutation, approval or RPC.

import { realpathSync, statSync } from "node:fs";
import type { ExtensionContext, Theme } from "@gsd/pi-coding-agent";
import { OVERLAY_MAX_HEIGHT_FRACTION, type AttentionSnapshotRead } from "@gsd/agent-modes";
import type { KeybindingsManager } from "@gsd/pi-tui";
import {
  AttentionOverlayComponent,
  AttentionOverlayController,
  createAttentionReader,
  type ReadRows,
} from "@gsd/agent-modes";
import { resolveProjectRootDbPath } from "./db-workspace.js";
import { inspectSqliteReadOnlySnapshot } from "./sqlite-readonly.js";
import { handleBlocker } from "./commands-blocker.js";

/**
 * Production seam: opens the project database strictly read-only through the
 * existing inspectSqliteReadOnlySnapshot (query_only, no bootstrap, no binding).
 * `ReadRows` adapts its DbAdapter to plain row queries.
 */
function productionSeam() {
  return {
    withReadOnlySnapshot<T>(path: string, inspect: (query: ReadRows) => T): T {
      return inspectSqliteReadOnlySnapshot(path, (db) =>
        inspect((sql) => db.prepare(sql).all() as Record<string, unknown>[]),
      );
    },
  };
}

/**
 * Resolve the same-project database path the way /gsd blocker does, and fail
 * closed when it is absent. A missing database is "unavailable", never all-clear.
 */
export function resolveAttentionDatabase(projectRoot: string): { ok: true; path: string; root: string } | { ok: false; reason: string } {
  try {
    const root = realpathSync(projectRoot);
    const path = realpathSync(resolveProjectRootDbPath(root));
    return { ok: true, path, root };
  } catch {
    return { ok: false, reason: "no-project-database" };
  }
}

/**
 * Shared controller factory: every entry point (command, keybinding, native
 * overlay) builds the same read-only controller. No entry point owns its own state.
 */
export function createAttentionController(
  projectRoot: string, sendCommand?: (command: string) => boolean | void,
): AttentionOverlayController {
  const resolved = resolveAttentionDatabase(projectRoot);
  const reader = resolved.ok
    ? createAttentionReader({ databasePath: resolved.path, projectRoot: resolved.root, seam: productionSeam() })
    : {
        // Absent database: every expected namespace is explicitly unavailable, never empty.
        readSnapshot: async (): Promise<AttentionSnapshotRead> => ({
          projectKey: null,
          sources: [
            { namespace: "workflow", status: "unavailable", completeness: "unknown", rows: [], reason: resolved.reason },
            { namespace: "auto-pause", status: "unavailable", completeness: "unknown", rows: [], reason: resolved.reason },
            { namespace: "interaction", status: "unavailable", completeness: "unknown", rows: [], reason: resolved.reason },
          ],
        }),
      };
  return new AttentionOverlayController(reader, { sendCommand });
}

/** Open the shared overview as a native overlay. Read-only; Escape closes. */
export async function showAttentionOverlay(ctx: ExtensionContext, projectRoot: string): Promise<void> {
  // Bind navigation to this mount's checkout and physical database, not whatever
  // workspace/host might be current when the user later presses Inspect.
  const owner = resolveAttentionDatabase(projectRoot);
  const binding = (() => {
    try {
      if (!owner.ok) return null;
      return { cwd: realpathSync(ctx.cwd), file: statSync(owner.path) };
    } catch { return null; }
  })();
  let finish: (() => void) | undefined;
  let inspectCommand: string | undefined;
  const controller = createAttentionController(projectRoot, (command) => {
    const current = resolveAttentionDatabase(projectRoot);
    try {
      if (!owner.ok || !current.ok || !binding || !finish
        || current.root !== owner.root || current.path !== owner.path
        || realpathSync(ctx.cwd) !== binding.cwd) throw new Error("owner changed");
      const file = statSync(current.path);
      if (file.dev !== binding.file.dev || file.ino !== binding.file.ino) throw new Error("database changed");
      // This callback can only enter the existing inspect branch, never resolve
      // or any agent/shell/SDK command dispatch route. IDs must be one token.
      if (!/^\/gsd blocker inspect \S+$/u.test(command)) throw new Error("invalid inspect target");
    } catch {
      ctx.ui.notify("Inspect navigation is unavailable for this checkout. Details only; nothing is sent or changed.", "warning");
      return false;
    }
    inspectCommand = command;
    controller.close();
    finish();
    return true;
  });
  await controller.open();
  await ctx.ui.custom<boolean>(
    (_tui, _theme: Theme, kb: KeybindingsManager, done) => {
      finish = () => done(true);
      return new AttentionOverlayComponent(controller, kb, () => done(true));
    },
    {
      overlay: true,
      overlayOptions: { width: "90%", minWidth: 60, maxHeight: `${Math.round(OVERLAY_MAX_HEIGHT_FRACTION * 100)}%`, anchor: "center" } as const,
    },
  );
  if (inspectCommand && owner.ok) {
    await handleBlocker(inspectCommand.slice("/gsd blocker ".length), ctx, owner.root);
  }
}
