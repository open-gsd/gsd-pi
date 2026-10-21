import type { LegacyImportForwardRepairChoice } from "./legacy-import-forward-repair-plan.js";

export function formatLegacyImportForwardRepairChoice(
  choice: Pick<LegacyImportForwardRepairChoice, "instructionIndex" | "targetKind" | "targetKey" | "reviewHash">,
  decision: LegacyImportForwardRepairChoice["decision"],
): string {
  const evidence = {
    instructionIndex: choice.instructionIndex,
    targetKind: choice.targetKind,
    targetKey: choice.targetKey,
    reviewHash: choice.reviewHash,
  };
  return `--choice=${Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url")}.${decision}`;
}

export function parseLegacyImportForwardRepairChoices(args: string): LegacyImportForwardRepairChoice[] {
  const pattern = /(?:^|\s)--choice=([A-Za-z0-9_-]+)\.(preserve-later|restore-backup)(?=\s|$)/gu;
  const choices: LegacyImportForwardRepairChoice[] = [];
  const identities = new Set<string>();
  for (const match of args.matchAll(pattern)) {
    let evidence: unknown;
    try {
      evidence = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
    } catch {
      throw new Error("recover Forward Repair choice token is invalid");
    }
    if (evidence === null
      || typeof evidence !== "object"
      || Object.keys(evidence).sort().join(",") !== "instructionIndex,reviewHash,targetKey,targetKind"
      || !Number.isSafeInteger((evidence as LegacyImportForwardRepairChoice).instructionIndex)
      || (evidence as LegacyImportForwardRepairChoice).instructionIndex < 0
      || typeof (evidence as LegacyImportForwardRepairChoice).targetKind !== "string"
      || (evidence as LegacyImportForwardRepairChoice).targetKind.trim().length === 0
      || typeof (evidence as LegacyImportForwardRepairChoice).targetKey !== "string"
      || (evidence as LegacyImportForwardRepairChoice).targetKey.trim().length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test((evidence as LegacyImportForwardRepairChoice).reviewHash)) {
      throw new Error("recover Forward Repair choice token is invalid");
    }
    const choice = {
      ...(evidence as Omit<LegacyImportForwardRepairChoice, "decision">),
      decision: match[2] as LegacyImportForwardRepairChoice["decision"],
    };
    const identity = `${choice.instructionIndex}\0${choice.targetKind}\0${choice.targetKey}`;
    if (identities.has(identity)) throw new Error("recover Forward Repair choice target is duplicated");
    identities.add(identity);
    choices.push(choice);
  }
  if (args.replace(pattern, " ").includes("--choice=")) {
    throw new Error("recover Forward Repair choice token is invalid");
  }
  return choices;
}
