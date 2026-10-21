// Project/App: gsd-pi
// File Purpose: Single workflow projection flush seam for mutation exits.

import { renderAllProjections } from "./workflow-projections.js";

export interface ProjectionFlushScope {
  milestoneId: string;
}

export interface ProjectionFlushResult {
  milestoneId: string;
  stale: boolean;
  superseded: boolean;
}

export interface ProjectionFlushFence {
  operationId: string;
  isCurrent: () => boolean;
}

let afterRenderForTest: (() => void) | null = null;

export function _setProjectionFlushAfterRenderForTest(hook: (() => void) | null): void {
  afterRenderForTest = hook;
}

export async function flushWorkflowProjections(
  basePath: string,
  scope: ProjectionFlushScope,
  fence?: ProjectionFlushFence,
): Promise<ProjectionFlushResult> {
  if (fence && !fence.isCurrent()) {
    return { milestoneId: scope.milestoneId, stale: false, superseded: true };
  }
  const rendered = await renderAllProjections(basePath, scope.milestoneId);
  afterRenderForTest?.();
  const superseded = fence ? !fence.isCurrent() : false;
  const repaired = superseded
    ? await renderAllProjections(basePath, scope.milestoneId)
    : null;
  return {
    milestoneId: scope.milestoneId,
    stale: rendered.stale || superseded || repaired?.stale === true,
    superseded,
  };
}
