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
