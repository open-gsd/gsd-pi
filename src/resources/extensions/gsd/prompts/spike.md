You are running the GSD **spike** workflow — experiential exploration that builds focused experiments to validate feasibility and produce verified knowledge for the real build.

## Spike Input

{{input}}

## Flags

- `--quick` — {{quickFlag}} (when true, skip decomposition/alignment and jump straight to building)
- `--text` — {{textFlag}} (when true, use plain-text numbered lists instead of interactive prompts)
- Frontier mode — {{frontierFlag}} (when true, analyze existing spikes and propose integration/frontier spikes instead of a new one)

## Process

### 1. Route the input

- If frontier mode is active (no idea given, or the word "frontier"): go to **Frontier mode**.
- Otherwise: continue to **Setup**.

### 2. Setup

Create `.gsd/spikes/` if it does not exist and determine the next spike number by listing existing `.gsd/spikes/[0-9][0-9][0-9]-*` directories. Use the project's detected stack (check `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`) to choose technology. Avoid heavy tooling — pick whatever reaches a runnable result fastest.

### 3. Decompose the idea (skip if `--quick`)

Break the idea into 1–3 focused experiments. Each experiment should validate one specific risk or assumption with a clear **Given/When/Then** validation question. Order by highest risk first.

### 4. Research (brief)

For each experiment, do the minimum research needed to start building — library docs, API shape, known gotchas. Use `resolve_library`/docs lookups. Do not over-research.

### 5. Build

Create `.gsd/spikes/{{spikeId}}/` and build each experiment as a small, self-contained, runnable artifact. Prefer throwaway code that proves the point. Hardcode configuration — do not build config systems.

### 6. Verify

For each experiment, run the validation question and record a verdict: `VALIDATED`, `PARTIAL`, or `INVALIDATED`, with the evidence (command output, observed behavior).

### 7. Document

Write `.gsd/spikes/{{spikeId}}/README.md` with:
- The original idea and the experiments run
- Per-experiment verdict + evidence
- Conclusions and recommendations for the real build
- Any conventions discovered worth recording (stack, patterns)

Append a one-line summary to `.gsd/CAPTURES.md` linking the README so the spike is discoverable.

### 8. Frontier mode (only when frontier flag is active)

Load the spike landscape: read `.gsd/spikes/*/README.md` and any `CONVENTIONS.md`. Analyze for **integration spikes** (validated spikes that share resources, hand off data, or contend) and **frontier spikes** (gaps, discovered dependencies, alternative approaches). Present concrete candidates with Given/When/Then questions and let the developer choose which to run.

## Success criteria

- Each experiment has a clear validation question and a recorded verdict with evidence.
- Artifacts live under `.gsd/spikes/{{spikeId}}/`.
- The README captures conclusions usable by the real build.
- No heavy infrastructure, build systems, or config layers unless the spike specifically requires them.
