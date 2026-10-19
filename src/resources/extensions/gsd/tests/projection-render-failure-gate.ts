// Project/App: gsd-pi
// File Purpose: Gate G5 helper for the tools that render after their commit.
//
// A tool test makes one projection write fail, runs the tool, and checks that
// the tool returned its committed receipt with `stale: true`. The test then
// removes the fault and calls this helper, which proves the other half of the
// gate: the failed render left Projection Work pending, and the next
// Projection Worker drain writes the same bytes as a clean render.

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";

import { listProjectionWorkHeads } from "../db/writers/projection-work-delivery.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { drainProjectionWork, projectionRendererFor } from "../projection-worker.ts";

/** Keys of the pending Projection Work heads that a registered renderer owns. */
function pendingProjectionWork(): string[] {
  return listProjectionWorkHeads(["pending"])
    .filter((head) => projectionRendererFor(head.projection_kind, head.projection_key) !== null)
    .map((head) => head.projection_key);
}

function readIfFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Call after a tool returned `stale: true` and the test removed the write
 * fault. `path` is the projection file that the tool could not render. Drains
 * at a time after every retry wait and compares the file with a clean render.
 */
export async function assertWorkerRendersStaleProjection(base: string, path: string): Promise<void> {
  const staleBytes = readIfFile(path);
  assert.notDeepEqual(pendingProjectionWork(), [], "the failed render leaves Projection Work pending");

  const drained = await drainProjectionWork(base, { now: new Date(Date.now() + 86_400_000) });

  assert.deepEqual(drained.errors, []);
  assert.deepEqual(pendingProjectionWork(), [], "the drain settles the pending work");
  const drainedBytes = readIfFile(path);
  assert.ok(drainedBytes !== null, "the drain renders the file");
  assert.notEqual(staleBytes, drainedBytes, "the file was stale before the drain");
  rmSync(path);
  assert.deepEqual((await renderAllFromDb(base)).errors, []);
  assert.equal(drainedBytes, readFileSync(path, "utf-8"), "drain bytes equal a clean render");
}
