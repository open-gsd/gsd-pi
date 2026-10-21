import type { Decision } from "./types.js";

const VALID_MADE_BY = new Set(["human", "agent", "collaborative"]);

export function parseDecisionsTable(content: string): Omit<Decision, "seq">[] {
  const results: Omit<Decision, "seq">[] = [];
  const amendsMap = new Map<string, string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|[-\s|]+\|$/u.test(trimmed)) continue;
    const cells = trimmed.split("|").map((cell) => cell.trim());
    if (cells[0] === "") cells.shift();
    if (cells.at(-1) === "") cells.pop();
    if (cells.length < 7) continue;

    const id = cells[0]!;
    if (id === "#" || id.toLocaleLowerCase("en-US") === "id" || !/^D\d+/u.test(id)) continue;
    const decision = cells[3]!;
    const amended = decision.match(/\(amends\s+(D\d+)\)/iu)?.[1];
    if (amended) amendsMap.set(amended, id);
    const rawMadeBy = (cells[7] ?? "agent").toLocaleLowerCase("en-US");

    results.push({
      id,
      when_context: cells[1]!,
      scope: cells[2]!,
      decision,
      choice: cells[4]!,
      rationale: cells[5]!,
      revisable: cells[6]!,
      made_by: (VALID_MADE_BY.has(rawMadeBy) ? rawMadeBy : "agent") as Decision["made_by"],
      superseded_by: null,
    });
  }

  for (const row of results) row.superseded_by = amendsMap.get(row.id) ?? null;
  return results;
}
