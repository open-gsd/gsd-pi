// Project/App: gsd-pi
// File Purpose: Read-only auto-pause inspection, or clear-only resolution with native terminal approval.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { truncateToWidth } from "@gsd/pi-tui";

import { getDb, getDbPath } from "./db/engine.js";
import { resolveProjectRootDbPath } from "./db-workspace.js";
import {
  classifyAutoPauseBlockerResolution, inspectAutoPauseBlockerFile, requirePauseBlockerCheckout,
  type AutoPauseBlockerResolutionInspection,
} from "./pause-blocker-inspection.js";
import { resolveAutoPauseBlockerById } from "./pause-blocker-domain-operation.js";

const USAGE = "Usage: /gsd blocker inspect <id>\n" +
  "/gsd blocker resolve <id> resolved <reason...>\n" +
  "Resolve requires the native human terminal UI, nonblank evidence and explicit confirmation. " +
  "It only clears an eligible auto-pause blocker; it never resumes work or resolves a Task.";

type Snapshot = AutoPauseBlockerResolutionInspection;

function describe(snapshot: Snapshot): string {
  // Explicit allowlist: no stored evidence, request payloads or runtime metadata.
  return JSON.stringify({
    projectId: snapshot.projectId,
    eligible: snapshot.eligible,
    failure: snapshot.failure,
    blocker: snapshot.blocker && {
      id: snapshot.blocker.id, kind: snapshot.blocker.kind, owner: snapshot.blocker.owner,
      scope: snapshot.blocker.scope, origin: snapshot.blocker.origin,
      lifecycleState: snapshot.blocker.lifecycleState,
    },
    pause: snapshot.pause && { id: snapshot.pause.id, scope: snapshot.pause.scope },
    revision: snapshot.revision,
    authorityEpoch: snapshot.authorityEpoch,
  }, null, 2);
}

/**
 * Positive native-host capability: interactive custom() executes this factory
 * and routes terminal keys to its component. RPC custom() is unsupported and
 * never runs the factory (even under a PTY with hasUI=true). Neither dialog
 * responses nor custom()'s return value grant approval.
 */
async function approveInNativeTerminal(ctx: ExtensionCommandContext, review: string): Promise<boolean> {
  if (typeof ctx.ui.custom !== "function") return false;
  let factoryExecuted = false;
  let acceptedByKeyHandler = false;
  await ctx.ui.custom<void>((_tui, _theme, _keys, done) => {
    factoryExecuted = true;
    const lines = ["Clear this auto-pause blocker only?", ...review.split("\n"),
      "Press y to approve, n or Escape to cancel. Nothing resumes or dispatches."];
    return {
      render: (width: number) => lines.map((line) => truncateToWidth(line, width)),
      invalidate() {},
      handleInput(data: string) {
        if (data === "y") {
          acceptedByKeyHandler = true;
          done();
        } else if (data === "n" || data === "\x1b" || data === "\x03") done();
      },
    };
  });
  return factoryExecuted && acceptedByKeyHandler;
}

export async function handleBlocker(
  args: string, ctx: ExtensionCommandContext, basePath: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const [action, blockerId, disposition, ...reasonParts] = parts;
  if (!blockerId || (action === "inspect" ? parts.length !== 2 :
    action !== "resolve" || disposition !== "resolved" || reasonParts.length === 0)) {
    ctx.ui.notify(USAGE, "warning");
    return;
  }

  try {
    const project = realpathSync(basePath);
    const commandCwd = realpathSync(ctx.cwd);
    const databasePath = realpathSync(resolveProjectRootDbPath(project));
    const checkProject = () => {
      if (realpathSync(basePath) !== project || realpathSync(ctx.cwd) !== commandCwd
        || realpathSync(resolveProjectRootDbPath(project)) !== databasePath) {
        throw new Error("Project or database path changed; inspect again in the intended checkout.");
      }
    };
    const readFile = (): Snapshot => {
      checkProject();
      return inspectAutoPauseBlockerFile(databasePath, project, blockerId);
    };
    const snapshot = readFile();
    if (action === "inspect") {
      ctx.ui.notify(describe(snapshot), "info");
      return;
    }
    if (!snapshot.eligible || !snapshot.blocker || !snapshot.pause) {
      ctx.ui.notify(`gsd blocker: Cannot resolve ${blockerId}: ${snapshot.failure ?? "ineligible blocker"}.`, "warning");
      return;
    }
    // Read existing host state only. No opener/probe that writes is permitted,
    // even for cancellation or a transport that cannot supply native approval.
    const requireExistingBinding = () => {
      checkProject();
      const boundPath = getDbPath();
      if (!boundPath || realpathSync(boundPath) !== databasePath) {
        throw new Error("No existing writable database binding for this checkout. Open the intended Project normally, then inspect again.");
      }
      const db = getDb();
      requirePauseBlockerCheckout(db, project);
      const bound = classifyAutoPauseBlockerResolution(db, blockerId);
      if (bound.authorityEpoch < 1 || describe(bound) !== describe(snapshot)
        || Number(db.prepare("PRAGMA query_only").get()?.["query_only"]) !== 0) {
        throw new Error("Existing writable canonical Project binding does not match approval; inspect again. No adoption or cutover was attempted.");
      }
      return db;
    };
    const originalDb = requireExistingBinding();
    const assertCurrent = () => {
      if (requireExistingBinding() !== originalDb || describe(readFile()) !== describe(snapshot)) {
        throw new Error("Project ID, blocker, revision or authority epoch changed; inspect again before resolving.");
      }
    };
    const evidence = await ctx.ui.input("Evidence for clearing this exact auto-pause blocker", "Required: verified evidence, not a plan to investigate");
    if (!evidence?.trim()) {
      ctx.ui.notify("gsd blocker: Cancelled; nonblank evidence is required. Nothing changed.", "warning");
      return;
    }
    assertCurrent();
    const rationale = reasonParts.join(" ");
    const approved = await approveInNativeTerminal(ctx, [
      `Checkout: ${project}`, describe(snapshot), `Rationale: ${rationale}`, `Evidence: ${evidence.trim()}`,
      "This atomically closes only the named blocker and associated pause, never a Task.",
    ].join("\n\n"));
    if (!approved) {
      ctx.ui.notify("gsd blocker: No native human terminal approval; cancelled. RPC/headless callers may only inspect.", "warning");
      return;
    }
    assertCurrent();

    // No await between the final file/bound checks and the atomic fenced operation.
    const result = resolveAutoPauseBlockerById({
      blockerId, rationale: `${rationale}\nEvidence: ${evidence.trim()}`,
      expectedProjectId: snapshot.projectId,
      expectedRevision: snapshot.revision,
      expectedAuthorityEpoch: snapshot.authorityEpoch,
      invocation: {
        sourceTransport: "internal", actorType: "user", actorId: "terminal-human",
        idempotencyKey: `terminal:blocker-resolve:${randomUUID()}`,
      },
    });
    if (!result.resolved) {
      ctx.ui.notify(`gsd blocker: Not resolved: ${result.failure ?? "refused"}. Inspect again.`, "warning");
      return;
    }
    ctx.ui.notify(`gsd blocker: Resolved ${blockerId} and its associated auto pause. No work was resumed or dispatched.`, "info");
  } catch (error) {
    ctx.ui.notify(`gsd blocker: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}
