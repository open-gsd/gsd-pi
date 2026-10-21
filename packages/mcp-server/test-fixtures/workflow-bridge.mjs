async function noop() {
  return { content: [{ type: "text", text: "noop" }] };
}

export const SUPPORTED_SUMMARY_ARTIFACT_TYPES = [];

export {
  noop as executeMilestoneStatus,
  noop as executePlanMilestone,
  noop as executePlanSlice,
  noop as executeReplanSlice,
  noop as executeReplanTask,
  noop as executeReworkBriefSave,
  noop as executeSliceComplete,
  noop as executeCompleteMilestone,
  noop as executeValidateMilestone,
  noop as executeReassessRoadmap,
  noop as executeSaveGateResult,
  noop as executeSummarySave,
  noop as executeUatResultSave,
  noop as executeTaskComplete,
  noop as executeTaskReopen,
  noop as executeTaskRecoveryResume,
  noop as executeTaskSettle,
  noop as executeSliceReopen,
  noop as executeSkipSlice,
  noop as executeMilestoneReopen,
};

export function loadWriteGateSnapshot() {
  return {};
}

export function shouldBlockPendingGateInSnapshot() {
  return { block: false };
}

export function shouldBlockQueueExecutionInSnapshot() {
  return { block: false };
}
