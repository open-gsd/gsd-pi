You are running the GSD **ingest-docs** workflow — bootstrap or merge a `.gsd/` setup from existing ADRs, PRDs, SPECs, and docs in the repo.

## Flags

- `--mode new|merge` — {{modeFlag}} (new = fresh .gsd/; merge = fold into existing)
- `--manifest <file>` — {{manifestFlag}} (a manifest listing which docs to ingest)
- `--resolve auto|interactive` — {{resolveFlag}}

## Source path

{{path}}

## Process

1. **Discover source docs.** Scan the given path (default: repo root) for decision records (ADRs, MADR, Nygard), PRDs, SPECs, RFCs, and READMEs that carry project knowledge. Apply the manifest filter if given.

2. **Classify each doc**: decision (→ Decisions Register), requirement/spec (→ CONTEXT/requirements), context/narrative (→ CONTEXT), architecture (→ CODEBASE or RESEARCH).

3. **Conflict detection.** When `--mode merge`, detect where ingested decisions contradict the existing Decisions Register and flag them.

4. **Resolve.** In `--resolve auto`, apply safe ingests and flag conflicts; otherwise confirm each.

5. **Bootstrap/merge.** For `--mode new`, run `/gsd init` then write the ingested artifacts. For `--mode merge`, append into the existing `.gsd/` artifacts. Record ingested decisions durably via `/gsd knowledge rule`.

## Success criteria

- Source docs are discovered and classified, not blindly copied.
- Merge conflicts are detected before writing.
- Decisions land in the Decisions Register; requirements in CONTEXT — not dumped as raw files.
- Bootstrap and merge both route through gsd-pi init/knowledge commands.
