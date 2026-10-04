// mcp-bridge.ts — stable runtime seam for MCP server consumption (phase 1).
export {
  loadWriteGateSnapshot,
  shouldBlockPendingGateInSnapshot,
  shouldBlockQueueExecutionInSnapshot,
} from "./bootstrap/write-gate.js";
export { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
export { openExistingWorkflowDatabase } from "./db-workspace.js";
export { readProgressFromDb, readProjectProgressFromDb } from "./state/progress-from-db.js";
export { readProjectSnapshotFromDb } from "./state/project-snapshot.js";
export { readKnowledgeMarkdown } from "./knowledge-projection.js";
export { loadActionableCaptures, loadAllCaptures, resolveCapture } from "./captures.js";
export {
  _getAdapter,
  checkpointDatabase,
  closeDatabase,
  getAllMilestones,
  getDb,
  getGateResults,
  getMilestoneSlices,
  getPendingGates,
  getSliceTasks,
  insertDecision,
  insertMilestone,
  insertSlice,
  openDatabase,
  upsertMilestonePlanning,
} from "./gsd-db.js";
export { invalidateStateCache } from "./state.js";
export { loadEffectiveGSDPreferences } from "./preferences.js";
export {
  saveDecisionToDb,
  saveRequirementToDb,
  updateRequirementInDb,
} from "./db-writer.js";
export { queryJournal } from "./journal.js";
