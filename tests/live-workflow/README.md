# gsd-pi live-workflow tests

End-to-end tests that drive the **real `gsd` binary** to dispatch a **real
agent** through the **real dispatch + verification gates** against a **real
model** — no fake-LLM transcript.

This is the live counterpart to the other two test layers:

| Layer | Dir | Agent | Network | In CI |
| --- | --- | --- | --- | --- |
| Fake-LLM e2e | `tests/e2e` | scripted JSONL transcript | none | yes (required gate) |
| Provider smoke | `tests/live` | real API, transport only | yes | no (manual) |
| **Workflow** | `tests/live-workflow` | **real agent, one unit or full `auto`** | yes | optional release CI + manual |

These exist to answer one question the other layers can't: *does a real agent,
given a real plan, actually execute through gsd's real gates to a correct,
durable outcome?* They are slow and cost real tokens, so they never run in the
default suite. Production release CI runs them as a non-blocking optional smoke
against the configured live workflow model.

Two scenarios:

| Script | Seed | Command | Proves | Default budget |
| --- | --- | --- | --- | --- |
| `test-tiny-milestone.ts` | 1 slice / 1 task | `gsd headless next` | one real agent turn passes the dispatch + verification gates and exits 0 | 300 s |
| `test-multi-slice-auto.ts` | S01 → S02 → S03, 5 tasks | `gsd headless auto` | the whole loop — every execute-task, every complete-slice (in dependency order), UAT recovery, and milestone closeout — finishes headlessly: the structured result and process both report success, all five per-task verifications pass, M001 + all slices + all tasks are `complete` in `.gsd/gsd.db`, and at least five commits are added | 2400 s |

The `auto` scenario is the one that matches what a user runs, including
milestone-closeout recovery after a non-passing UAT. `next` stays as the fast,
cheap smoke of a single dispatch.

## Running

```bash
# 1. Build the binary the test will drive.
npm run build:core && chmod +x dist/loader.js

# 2. Export a provider credential (any vendor) and run.
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY, or any *_API_KEY / *_OAUTH_TOKEN
GSD_LIVE_TESTS=1 \
GSD_SMOKE_BINARY="$(pwd)/dist/loader.js" \
npm run test:live-workflow
```

Without `GSD_LIVE_TESTS=1` the runner is a no-op. With it set but no provider
credential in the environment, each test **skips** (POSIX exit 77) rather than
failing.

If your credentials live in `~/.gsd/agent/auth.json` (no `*_API_KEY` in the
shell), opt in to forwarding your real HOME so the child authenticates exactly
like you do:

```bash
GSD_LIVE_TESTS=1 GSD_LIVE_WORKFLOW_USE_HOME=1 \
GSD_SMOKE_BINARY="$(pwd)/dist/loader.js" \
node --experimental-strip-types tests/live-workflow/test-multi-slice-auto.ts
```

### Env knobs

| Var | Default | Purpose |
| --- | --- | --- |
| `GSD_LIVE_TESTS` | — | Must be `1` or the suite is skipped entirely. |
| `GSD_SMOKE_BINARY` | `gsd` on PATH | Built binary to drive (recommended). |
| `*_API_KEY` / `*_OAUTH_TOKEN` | — | Provider credential, forwarded to the child. At least one required. Provider-agnostic. |
| `GSD_LIVE_WORKFLOW_MODEL` | auto-resolved (`openai/gpt-5.4-mini` in optional release CI) | Force a model id. Unset = gsd picks the default for whichever provider's credential is present. |
| `GSD_LIVE_WORKFLOW_USE_HOME` | — | `1` forwards your real `HOME` so the child reads `~/.gsd/agent/auth.json` and prefs. Counts as a credential source. Off by default: the child normally gets an isolated, fresh home. |
| `GSD_LIVE_WORKFLOW_TIMEOUT_MS` | `300000` (`next`) / `2400000` (`auto`) | Harness wall-clock budget. When explicitly set it also becomes the headless auto timeout; otherwise auto's overall product timeout stays disabled. |
| `GSD_LIVE_WORKFLOW_RUNNER_TIMEOUT_MS` | — | Optional extra per-test deadline for `run.ts`. Unset = none; each scenario already kills its own gsd child at its budget. |
| `GSD_LIVE_WORKFLOW_OUTPUT` | `stream-json` | Output format. `stream-json` provides the authoritative terminal result; set `text` for a readable diagnostic transcript. |

## How it works

Each `test-*.ts` script:

1. **Seeds a milestone** in a throwaway git project — one slice/one task for
   `next`, three dependent slices/five tasks for `auto` — where every task's
   verification is a runnable command (`node --test ...`). The bundled tests
   *fail* until the agent does the work. A `package.json` `test` script is
   included so gsd's verification gate has a host-owned check to discover and
   run. After seeding it runs the **two-step** `gsd headless recover`: the
   first call prints an import preview and a `--preview=sha256:<hash>` hint
   (exit non-zero), the second call with that hash applies it. The result is
   committed so the pre-dispatch `git diff --check` guard sees a clean tree.
2. **Forwards credentials from the environment.** Any `*_API_KEY` /
   `*_OAUTH_TOKEN` in your shell is passed to the child; nothing reads or
   touches your real `~/.gsd`. The child keeps the e2e harness's isolated,
   fresh agent home, so the test behaves identically locally and in CI.
   Provider-agnostic by construction — no vendor is named anywhere.
   (`GSD_LIVE_WORKFLOW_USE_HOME=1` is the opt-in exception, see above.)
3. **Dispatches**: `gsd headless --output-format stream-json
   --timeout <T> --max-restarts 0 [--model <M>] <next|auto>`. `next` runs a
   single real agent turn (execute-task) through the verification gate, then
   exits; `auto` keeps dispatching until the milestone is closed.
4. **Asserts on durable outcomes only** — never on agent prose, which drifts:
   - exit code `0` (success; `10`=blocked, `1`=error/timeout, `11`=cancelled),
   - the task's own verification command now **passes**,
   - the agent added at least one git commit,
   - (`auto` only) every per-task verification passes, `milestones`/`slices`/
     `tasks` rows for M001 and all seeded slices/tasks read `complete` in
     `.gsd/gsd.db`, slices' `completed_at` respects the `depends` order,
     commits grew by at least the task count. In the default `stream-json` mode,
     the final `headless_result` must report `status: "success"` and `exitCode: 0`.
     Text mode is diagnostic only because it mixes engine notices with model
     prose and tool-call display lines.

Artifacts (transcript + raw streams) are written under `test-results/e2e/` for
post-mortem.

## Seeing the output

By default the run uses `--output-format stream-json`. The JSONL event stream
is printed live and saved for post-mortem, and its final `headless_result` is
the authoritative workflow result. The harness also saves a combined,
ANSI-stripped transcript:

```bash
# the test prints this path near the end as `transcript: <path>`
cat test-results/e2e/<timestamp>_live-tiny-milestone/transcript.txt   # clean, ANSI-stripped
# raw streams are kept alongside it:
#   dispatch.stdout.log   dispatch.stderr.log
```

For a readable diagnostic transcript instead, set:

```bash
GSD_LIVE_WORKFLOW_OUTPUT=text GSD_LIVE_TESTS=1 npm run test:live-workflow
```

To extract only assistant prose from the default JSONL stream:

```bash
jq -rc 'select(.type=="agent_end") | .messages[]
        | select(.role=="assistant") | .content[]?
        | select(.type=="text") | .text' \
  test-results/e2e/<timestamp>_live-tiny-milestone/dispatch.stdout.log
```

## Writing a new live-workflow test

1. Create `tests/live-workflow/test-<name>.ts`. The `test-*.ts` glob is what
   `run.ts` executes.
2. Import seeding/credential helpers from `./harness.ts` and process helpers
   from `../e2e/_shared/index.ts`.
3. Skip with `process.exit(77)` when prerequisites are missing; fail with a
   non-zero exit otherwise. Use `try/finally` to clean up the tmp project
   (these are standalone scripts, not `node:test` files).
4. **Assert on durable state, not words.** Re-run a verification command,
   read the DB/markdown/git — never `assert.match` on what the model said.

## Anti-patterns

- ❌ Asserting on agent response text. It changes every run — you'll flake.
- ❌ Large/open-ended milestones. Keep tasks trivial and unambiguous; this is a
   smoke test of the *loop*, not a benchmark of model capability.
- ❌ Running in the default test suite or a required CI gate. Cost + nondeterminism.
