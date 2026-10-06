// Project/App: gsd-pi
// File Purpose: Parse the Milestone Sequence of a PROJECT.md artifact.
// This module has no runtime import, so a reader that does not open the
// workflow database (the web project picker) can use the same parser.

export interface ProjectSequenceMilestone {
  id: string;
  title: string;
  oneLiner: string;
  done: boolean;
}

const H2_RE = /^##\s+(.+)$/gm;
// A milestone line is single-line by construction. Every inter-token gap uses
// horizontal-whitespace classes (`[^\S\n]`) rather than `\s`, because `\s`
// matches newlines: a line missing a valid separator would otherwise let the
// `\s+(?:—|--|-)\s+` clause "bridge" onto the NEXT bullet's `- `, consuming it
// as the separator and silently swallowing the following well-formed milestone.
const MILESTONE_LINE_RE = /^-[^\S\n]+\[([ x])\][^\S\n]+(M\d{3}):[^\S\n]+(.+?)[^\S\n]+(?:—|--|-)[^\S\n]+(.+)$/gm;

export function splitH2Sections(content: string): { sections: Record<string, string>; order: string[] } {
  const sections: Record<string, string> = {};
  const order: string[] = [];
  const headerMatches: Array<{ name: string; index: number; lineEnd: number }> = [];

  for (const m of content.matchAll(H2_RE)) {
    if (m.index === undefined) continue;
    headerMatches.push({
      name: m[1].trim(),
      index: m.index,
      lineEnd: m.index + m[0].length,
    });
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const start = headerMatches[i].lineEnd;
    const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : content.length;
    const body = content.slice(start, end).trim();
    sections[headerMatches[i].name] = body;
    order.push(headerMatches[i].name);
  }

  return { sections, order };
}

export function parseMilestoneSequence(sections: Record<string, string>): ProjectSequenceMilestone[] {
  const milestones: ProjectSequenceMilestone[] = [];
  const sequenceBody = sections["Milestone Sequence"] ?? "";
  for (const m of sequenceBody.matchAll(MILESTONE_LINE_RE)) {
    milestones.push({
      done: m[1] === "x",
      id: m[2],
      title: m[3].trim(),
      oneLiner: m[4].trim(),
    });
  }
  return milestones;
}
