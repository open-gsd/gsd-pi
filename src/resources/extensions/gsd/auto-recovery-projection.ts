// Project/App: gsd-pi
// File Purpose: Bounded, display-only audit projection of canonical auto-recovery events.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AUTO_RECOVERY_AUTHORIZATION_PROJECTION_KIND } from "./auto-recovery-authorization.js";
import { writeProjectionFileSync } from "./compat/compat-marker.js";
import { getDb } from "./db/engine.js";
import { logWarning } from "./workflow-logger.js";

export function renderAutoRecoveryProjection(basePath: string): void {
  const rows = getDb().prepare(`
    SELECT project_revision, event_type, entity_id, payload_json
    FROM workflow_domain_events
    WHERE entity_type = :kind
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 200
  `).all({ ":kind": AUTO_RECOVERY_AUTHORIZATION_PROJECTION_KIND }) as Array<{
    project_revision: number; event_type: string; entity_id: string; payload_json: string;
  }>;
  const cell = (value: unknown): string => String(value ?? "").replace(/[|\r\n]/g, " ").slice(0, 160);
  const lines = [
    "# Auto-recovery audit", "",
    "Display-only projection of the latest 200 canonical events; the database retains the full history.",
    "Editing this file cannot grant consent, authorize a retry, or waive a human gate.", "",
    "| Revision | Event | Authorization | Run |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows.reverse()) {
    let runId: unknown = "";
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const value = (payload as Record<string, unknown>).runId;
        if (typeof value === "string") runId = value;
      }
    } catch {
      // A malformed historical payload is not authority and must not break delivery.
      logWarning("renderer", "Malformed auto-recovery audit payload; omitting run ID from display", {
        revision: String(row.project_revision),
      });
    }
    lines.push(`| ${cell(row.project_revision)} | ${cell(row.event_type)} | ${cell(row.entity_id)} | ${cell(runId)} |`);
  }
  const content = `${lines.join("\n")}\n`;
  const directory = join(basePath, ".gsd");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "AUTO-RECOVERY.md");
  writeProjectionFileSync(basePath, path, content, []);
}
