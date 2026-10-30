# Graphify known-answer fixture (C07-A)

## Scope

This public, credential-free fixture records source facts for the C07-A baseline in
[#2960](https://github.com/open-gsd/gsd-pi/issues/2960), under umbrella
[#2953](https://github.com/open-gsd/gsd-pi/issues/2953). It does not install or invoke
an external provider, define an accepted provider response contract, or prove host adoption.

The fixture's JSON is a source-grounded answer oracle for these files only. It is not
a proposal for the C02 runtime contract. Unknown or dynamic targets stay unresolved;
imports alone do not count as calls.

## Known-answer facts

| Case | Expected source fact | Boundary |
| --- | --- | --- |
| Primary caller | `renderPrimary` calls `formatLabel` | Direct call site |
| Secondary caller | `renderSecondary` calls `formatLabel` | Direct call site |
| Import-only module | Imports and retains `formatLabel` as a value | Must not become a `calls` fact |
| Dynamic dispatcher | Calls a handler selected by `registry[name]` | Target is unresolved, not `formatLabel` |

The sources are deliberately small and synthetic. They contain no credentials,
customer data, generated graph, private repository material, or provider output.

## Run the fixture-integrity test

From the repository root:

```bash
node --test src/resources/extensions/gsd/tests/graphify-known-answer-fixture.test.mjs
```

This test checks that the fixture and its expected facts remain internally aligned.
It does **not** run Graphify, a provider, an MCP server, or a host session, and must not
be reported as provider-accuracy evidence.

## Assess observations (C07 test only)

`assess-observations.mjs` exports `assessFixtureObservations(observation)`. It compares
hand-recorded observations with the **unchanged** `expected-facts.json` oracle and checks
literal evidence at one-based lines in the local fixture files. It does not extract calls,
consume a native entity graph, invoke a provider, or define the C02 runtime contract.

This complete **mock** input illustrates the fixture-only representation:

```json
{
  "format": "gsd-graphify-c07-observations",
  "version": 1,
  "fixture": "graphify-known-answer",
  "availability": "available",
  "provenance": {
    "kind": "mock",
    "reference": "example-only-not-a-pilot-log",
    "sourceRevision": "0000000000000000000000000000000000000000"
  },
  "facts": [
    {
      "source": "caller-primary.ts#renderPrimary", "relation": "calls", "target": "helper.ts#formatLabel",
      "anchors": [{ "line": 4, "text": "return formatLabel(value);" }]
    },
    {
      "source": "caller-secondary.ts#renderSecondary", "relation": "calls", "target": "helper.ts#formatLabel",
      "anchors": [{ "line": 3, "text": "formatLabel(value)" }]
    },
    {
      "source": "import-only.ts", "relation": "imports", "target": "helper.ts#formatLabel",
      "anchors": [{ "line": 1, "text": "import { formatLabel } from \"./helper.js\";" }]
    },
    {
      "source": "dynamic-dispatch.ts#invokeByName", "relation": "dynamic-call", "target": "unresolved",
      "anchors": [
        { "line": 6, "text": "const handler = registry[name];" },
        { "line": 7, "text": "handler(value)" }
      ]
    }
  ]
}
```

For an actual bounded pilot, transcribe what the route **actually reports**, cross-check its
anchors against source, and retain the original output and run metadata from the recipe below.
Use `kind: "source-grounded"`, a reference to that durable evidence, and its full Git source
revision (40 or 64 lowercase hex characters). Do not fill missing observations from the oracle.
Provenance is declared, not authenticated: the assessor does not verify the revision, freshness,
worktree identity, evidence-log contents, or whether the reported facts genuinely came from a route.
The caller must check those boundaries separately. `kind: "mock"` proves only assessor behavior.

The object keys shown above are exact; unknown fields reject. Each fact needs all oracle evidence
quotes, including both dynamic lookup and invocation. Fact/anchor order is irrelevant.
Availability describes the **whole** observation: use `missing`, `unsupported`, `partial`,
`truncated`, `stale`, or `failed` when coverage is not complete, even if some facts are known.
A native graph that only represents entities/imports is not a function-call graph: record
`unsupported` with `facts: []`, not invented callers or an authoritative empty answer.

- `PASS`: all four oracle facts and source anchors match, with `availability: "available"`.
  This is a fixture comparison only, **not** native-route, provider-accuracy, or host-adoption proof.
- `FAIL`: malformed/out-of-scope facts, bad anchors, duplicate/contradictory facts, wrong relations
  or targets, or missing facts under claimed complete availability (including an empty answer).
- `INCONCLUSIVE`: valid but unavailable/incomplete evidence, whether empty or otherwise correct.
  Contradictory or malformed facts still fail; unavailable coverage never becomes PASS.

To assess a saved JSON observation from the repository root (exit 0/1/2 for PASS/FAIL/INCONCLUSIVE):

```bash
node --input-type=module - ./c07-observations.json <<'JS'
import { readFileSync } from "node:fs";
import { assessFixtureObservations } from "./src/resources/extensions/gsd/tests/fixtures/graphify-known-answer/assess-observations.mjs";
const observation = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = assessFixtureObservations(observation);
console.log(JSON.stringify(result, null, 2));
process.exitCode = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 }[result.verdict];
JS
```

Run the assessor's mocked positive/negative cases together with the original integrity assertions:

```bash
node --test src/resources/extensions/gsd/tests/graphify-known-answer-assessor.test.mjs src/resources/extensions/gsd/tests/graphify-known-answer-fixture.test.mjs
```

## Future proof recipe

After C02/C03 select and approve a route and its contract, a provider-specific acceptance
run can use these inputs:

1. Record the exact source SHA, dirty/untracked state, fixture identity, provider/version,
   selected consumer/host, environment, command, and terminal result.
2. Compare observed facts with the fixture oracle: both direct calls should be found;
   the import-only case should not be promoted to a call; the dynamic target should remain
   unresolved unless the accepted contract supports stronger evidence.
3. Keep missing, unsupported, truncated, stale, and failed coverage distinct from an
   empty result. Do not treat unknown coverage as proof that no callers exist.
4. Exercise the boundary cases listed in `expected-facts.json`: dirty and new sources,
   deletions, relevant configuration changes, identical relative paths in separate
   worktrees, and a source change during the query.
5. Preserve source ownership, redaction, cancellation, output limits, and no-write
   behavior established by the accepted contract. Do not capture secrets or customer data.

These later checks are not executed by this fixture-only contribution. Provider, package,
and authentic host/session acceptance remain gated Phase B work under #2960.
