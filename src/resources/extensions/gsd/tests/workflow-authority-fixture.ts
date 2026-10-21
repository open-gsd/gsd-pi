import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  transaction,
} from "../gsd-db.ts";
import { saveDecisionToDb, saveRequirementToDb } from "../db-writer.ts";
import { invalidateStateCache } from "../state.ts";

export interface WorkflowAuthorityFixture {
  root: string;
  dbPath: string;
  ids: {
    milestone: string;
    completedSlice: string;
    readySlice: string;
    completedTask: string;
    readyTask: string;
    requirement: string;
    decision: string;
  };
  reopen(): void;
  cleanup(): void;
}

function openFixtureDatabase(dbPath: string): void {
  if (!openDatabase(dbPath)) {
    throw new Error(`Could not open workflow authority fixture database: ${dbPath}`);
  }
}

export async function createWorkflowAuthorityFixture(): Promise<WorkflowAuthorityFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-workflow-authority-")));
  const dbPath = join(root, ".gsd", "gsd.db");
  let cleanedUp = false;

  mkdirSync(join(root, ".gsd"), { recursive: true });
  openFixtureDatabase(dbPath);

  try {
    transaction(() => {
      insertMilestone({ id: "M001", title: "Authority Fixture", status: "active" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        title: "Completed prerequisite",
        status: "complete",
        risk: "low",
        depends: [],
        sequence: 1,
      });
      insertSlice({
        id: "S02",
        milestoneId: "M001",
        title: "Ready dependent slice",
        status: "pending",
        risk: "medium",
        depends: ["S01"],
        sequence: 2,
      });
      insertTask({
        id: "T01",
        milestoneId: "M001",
        sliceId: "S01",
        title: "Completed task",
        status: "complete",
        sequence: 1,
      });
      insertTask({
        id: "T01",
        milestoneId: "M001",
        sliceId: "S02",
        title: "Ready task",
        status: "pending",
        sequence: 1,
      });
    });

    const requirement = await saveRequirementToDb(
      {
        class: "core-capability",
        status: "active",
        description: "SQLite is authoritative",
        why: "Readable projections must not control workflow state.",
        source: "workflow-authority-fixture",
        primary_owner: "M001/S02",
        validation: "DB-derived state remains canonical",
      },
      root,
    );
    const decision = await saveDecisionToDb(
      {
        when_context: "M001/S02",
        scope: "architecture",
        decision: "Choose the workflow authority",
        choice: "SQLite is authoritative",
        rationale: "Projections may lag without losing saved intent.",
        revisable: "No",
        made_by: "human",
        source: "discussion",
      },
      root,
    );

    return {
      root,
      dbPath,
      ids: {
        milestone: "M001",
        completedSlice: "S01",
        readySlice: "S02",
        completedTask: "T01",
        readyTask: "T01",
        requirement: requirement.id,
        decision: decision.id,
      },
      reopen() {
        closeDatabase();
        openFixtureDatabase(dbPath);
        invalidateStateCache();
      },
      cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        closeDatabase();
        invalidateStateCache();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
