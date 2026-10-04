// Project/App: gsd-pi
// File Purpose: Real-process worker that opens a project database when its parent says so, for the concurrent first-open cutover test.

import { openWorkflowDatabase } from "../db-workspace.ts";
import { closeDatabase } from "../gsd-db.ts";
import { peekLogs, setStderrLoggingEnabled } from "../workflow-logger.ts";

setStderrLoggingEnabled(false);
process.stdin.once("data", () => {
  const opened = openWorkflowDatabase(process.argv[2]!);
  closeDatabase();
  process.stdout.write(`\n${JSON.stringify({
    ok: opened.ok,
    logs: peekLogs().map((entry) => ({ severity: entry.severity, message: entry.message })),
  })}`);
  process.exit(0);
});
process.stdout.write("ready");
