You are running the GSD **sketch** workflow — explore UI/design ideas with throwaway HTML mockups that let the developer feel a design before committing to implementation.

## Design Idea

{{input}}

## Flags

- `--quick` — {{quickFlag}} (when true, skip decomposition and jump straight to a single mockup)
- `--text` — {{textFlag}} (when true, use plain-text numbered lists instead of interactive prompts)
- Frontier mode — {{frontierFlag}} (when true, analyze existing sketches and propose what to sketch next instead of a new one)

## Process

### 1. Route the input

- If frontier mode is active (no idea given, or the word "frontier"): go to **Frontier mode**.
- Otherwise: continue to **Setup**.

### 2. Setup

Create `.gsd/sketches/` if it does not exist and determine the next sketch number by listing existing `.gsd/sketches/[0-9][0-9][0-9]-*` directories.

### 3. Decompose the design (skip if `--quick`)

If the design idea has multiple surfaces (e.g. landing page, dashboard, empty state), break it into focused mockups. Each should explore one surface or one interaction. Order by the most uncertain design direction first.

### 4. Align on direction

Briefly confirm scope and any constraints (brand, target device, accessibility). Keep this short — sketches are cheap and disposable.

### 5. Build

Create `.gsd/sketches/{{sketchId}}/` and build each mockup as a self-contained `index.html` (inline CSS/JS, no build step). Open it in the browser via the project's tooling so the developer can see and react to it.

### 6. Observe and refine

Let the developer react to each mockup. Iterate quickly on the throwaway HTML. Capture the design decisions that emerge (layout, color, motion, copy).

### 7. Document

Write `.gsd/sketches/{{sketchId}}/README.md` with:
- The design idea and the surfaces explored
- The mockup files and what each demonstrates
- Design decisions captured and their rationale
- Recommendations for the real implementation

Append a one-line summary to `.gsd/CAPTURES.md` linking the README.

### 8. Frontier mode (only when frontier flag is active)

Load the sketch landscape: read `.gsd/sketches/*/README.md`. Analyze for **integration sketches** (sketches that touch the same flow) and **frontier sketches** (unexplored surfaces, alternative directions, empty/loading/error states). Present concrete candidates and let the developer choose which to run.

## Success criteria

- Each mockup is a self-contained `index.html` with no build step.
- Artifacts live under `.gsd/sketches/{{sketchId}}/`.
- The README captures design decisions usable by the real implementation.
- Iteration is fast and the sketches stay disposable.
