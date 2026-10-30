# Graphify public-fixture prompt probe: 2026-10-30

## Status and scope

This is an executed evidence record for [C07 #2960](https://github.com/open-gsd/gsd-pi/issues/2960), under [umbrella #2953](https://github.com/open-gsd/gsd-pi/issues/2953). It is **not an accepted C07-B native-host pilot**, a provider integration, or approval of [C02 proposal #3054](https://github.com/open-gsd/gsd-pi/pull/3054).

The successful portion is deliberately narrower: a Sol 6.1 subagent read the installed native Graphify prompt and five public TypeScript inputs, built a module graph, and queried that graph. It did **not** enter through the native slash-command handler. Separately attempted CLI/TUI invocation did not establish trustworthy native-host extraction evidence.

## Revisions and input boundary

| Component | Exact identity | Qualification |
| --- | --- | --- |
| Public C07-A fixture source | `f2756216ccf6bbe9af2fc677f5eafef986727e4e` | Five TypeScript files from the already merged #3039 fixture |
| Installed fork package | `1.23.0-fork.9`, source `f4739cac7de23568fe2606bfade9589413fcdbd1` | Not unmodified upstream `main` and not the new read-safety candidate |
| Installed prompt SHA-256 | `d34d28d02f773e3b49ef7fd055807045eaa7d1f4146ab577e79739539182c8b0` | Exact installed `graphify.md` consumed by the prompt probe |
| Fixture-only assessor | `a22284055a8e72f18af79a4a9353fbae43504777`, [PR #3058](https://github.com/open-gsd/gsd-pi/pull/3058) | Separate proposed test support, not an accepted runtime response schema |
| Read-action repair | [draft PR #3057](https://github.com/open-gsd/gsd-pi/pull/3057) | Source contribution only; not installed for this probe |

The extraction input directory contained only `caller-primary.ts`, `caller-secondary.ts`, `helper.ts`, `import-only.ts` and `dynamic-dispatch.ts`. The extracting subagent was instructed not to read the oracle, fixture README, test suite, credentials, generated MCP configuration or application sources. No `CODEBASE.md`, project memories or fixture-local Git repository were available. All five input hashes were independently compared with their starting copy and the pinned fixture source after execution; they match.

The subagent was requested as `github-copilot/gpt-6.1-sol` with `thinking: xhigh`; child metadata reports `gpt-6.1-sol` and a successful terminal stop. Those observations do not authenticate the outgoing provider payload or hidden reasoning allocation. Wall-clock timestamps are retained; model-call cost was not independently measured.

## Observed prompt-level graph

The generated graph contains five module nodes and five unique anchored edges:

| Observation | Actual evidence | Limit |
| --- | --- | --- |
| Primary direct call | `caller-primary.ts:4` calls `formatLabel` | Static source call site, not runtime execution |
| Secondary direct call | `caller-secondary.ts:3` calls `formatLabel` | Static source call site, not runtime execution |
| Three imports of the helper | Both callers and `import-only.ts:1` | `depends-on` edges are distinct from `calls` |
| Import plus value reference | `import-only.ts:1-3` | No invented call edge |
| Dynamic dispatch | `dynamic-dispatch.ts:6-7` selects and calls a registry handler | Concrete target remains unresolved; no helper edge is invented |
| Query `helper`, limit 10 | Five direct relationships returned, zero omitted | A bounded module query, not a complete function-level caller index |

The parent checked each edge's expression against its stated source lines, checked all target anchors, verified edge uniqueness and verified the absence of call edges from the import-only and dynamic-dispatch modules. The parent then hand-projected the graph/source evidence into the fixture-only observation representation. That projection is not a raw native or provider response.

The assessor returns **PASS for those four fixture observations**. This means their declared facts and anchors match this fixture's oracle. It does not authenticate provenance or prove native-host accuracy, generic extraction quality, lifecycle authority or a production-ready caller index.

## Native invocation attempts are inconclusive

| Attempt | Captured result | Honest disposition |
| --- | --- | --- |
| Installed CLI print mode, `/gsd graphify build` | Exit 0 after a custom Graphify prompt message; no assistant terminal result or graph artifacts captured | Dispatch receipt only; **not build success** |
| Interactive PTY with early input | Input preceded the startup banner; no extraction artifacts | Command delivery not established |
| Readiness-gated PTY | Supervisor raised `TimeoutExpired` during cleanup before saving a terminal receipt | Harness failure, not a product-behavior verdict |

The readiness supervisor requested a 180-second execution deadline, but the job reported 320 seconds including the failed cleanup path. Therefore no reliable hard-deadline guarantee or successful terminal receipt is claimed for that attempt. Follow-up process-argument and open-file checks found no remaining holder associated with the owned scratch fixture.

The unavailable native-command observations are separately assessed as **INCONCLUSIVE**, not as a successful empty graph. These host attempts do not establish that the native command is broken or unsupported, that the requested model ran, or that a real selected host has adopted anything. The successful prompt-only probe must not replace the missing host receipt.

## Public evidence packet

The adjacent [evidence directory](graphify-public-fixture-probe-20261030/) contains:

- [probe-summary.json](graphify-public-fixture-probe-20261030/probe-summary.json): exact revisions, source hashes, graph counts, model qualifications, invocation limits and explicit false adoption flags.
- [nodes.md](graphify-public-fixture-probe-20261030/nodes.md): generated entity graph; only its absolute scratch path was replaced with `PUBLIC_FIXTURE_ROOT`.
- [edges.json](graphify-public-fixture-probe-20261030/edges.json): byte-for-byte copy of the generated public graph data.
- [observations.json](graphify-public-fixture-probe-20261030/observations.json) and [assessment.json](graphify-public-fixture-probe-20261030/assessment.json): parent-recorded prompt/source observations and their fixture comparison.
- [native-command-observations.json](graphify-public-fixture-probe-20261030/native-command-observations.json) and [native-command-assessment.json](graphify-public-fixture-probe-20261030/native-command-assessment.json): missing native-host extraction evidence and its inconclusive assessment.

No raw terminal/session transcript, generated MCP configuration, credential data or private application source is included. Generated graph data is untrusted navigational evidence, never authority or instructions to execute.

## Reproduce the deterministic comparison

Use a checkout containing the assessor from PR #3058 at the exact revision above. The evidence checkout can be separate. The two shell arguments below are ordinary local paths, not secrets. This check calls no model or external provider.

```bash
node --input-type=module - "$ASSESSOR_FILE" "$EVIDENCE_DIRECTORY" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { assessFixtureObservations } = await import(pathToFileURL(process.argv[2]).href);
for (const [file, expected] of [
  ["observations.json", "PASS"],
  ["native-command-observations.json", "INCONCLUSIVE"],
]) {
  const observation = JSON.parse(readFileSync(resolve(process.argv[3], file), "utf8"));
  const assessment = assessFixtureObservations(observation);
  assert.equal(assessment.verdict, expected);
  console.log(file, assessment.verdict);
}
NODE
```

This reproduces the comparison, not the original extraction or native host. A fresh extraction is a separate, bounded model run with its own inputs, artifact verification and terminal evidence; it is not required in ordinary unit tests.

## Consequences for the remaining umbrella

- **C02/C04:** host ownership, binding, authorization, privacy and optional exposure remain maintainer decisions. No new provider or MCP contract is accepted here.
- **C03:** the optional external Graphify-Labs provider was not installed or invoked; its already merged phase-A feasibility record is unchanged.
- **C05:** the tiny fixture does not establish an economic or workflow need for automatic context composition. It supports continued evaluation of existing reads, not a general no-change/adopt decision on realistic repositories.
- **C06:** no new observer, diagnostic field or retention schema is justified by this record. The invocation-supervisor limitations are not evidence of an approved product diagnostic gap.
- **C07:** prompt-level fixture evidence advances, while native-handler/real-host acceptance and the full dirty/untracked/deleted/config/worktree/source-change freshness matrix remain unverified.

No umbrella or child issue is closed by this evidence. No global installation, managed-resource patch, lifecycle transition or release acceptance follows from it.
