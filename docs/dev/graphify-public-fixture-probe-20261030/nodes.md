# Public-fixture entity graph

Action: build. Source root: `PUBLIC_FIXTURE_ROOT`.

This is manual agent extraction using the installed GSD graphify prompt, not proof of the native slash-command handler or host adoption. Source hashes and prompt identity are in `provenance.json`. No fixture-local Git repository exists: HEAD, dirty state, and Git-based freshness are unavailable. Hash freshness is scoped to the five explicit source inputs only.

## Entities

| Stable id | Type | File path and anchor | Description |
| --- | --- | --- | --- |
| module:caller-primary | module | `caller-primary.ts:1-5` | Exports `renderPrimary`; imports and directly calls `formatLabel` at line 4. |
| module:caller-secondary | module | `caller-secondary.ts:1-3` | Exports `renderSecondary`; imports and directly calls `formatLabel` at line 3. |
| module:import-only | module | `import-only.ts:1-3` | Imports `formatLabel` and exports its function reference at line 3; no invocation is present. |
| module:helper | module | `helper.ts:1-3` | Exports `formatLabel`, which prefixes a trimmed string with `label:`. |
| module:dynamic-dispatch | module | `dynamic-dispatch.ts:1-8` | Exports `invokeByName`, selects `registry[name]` at line 6 and conditionally invokes `handler(value)` at line 7. |

## Relationship semantics and limits

- `depends-on` edges record explicit static imports. `./helper.js` resolves by this fixture's TypeScript source correspondence to `helper.ts`; no compiled JavaScript was inspected or executed.
- `calls` edges record observed direct call expressions, not import-only inference. Symbol names are evidence annotations, not function entities or a complete function-level caller index.
- `dynamic-dispatch.ts:7` has an actual indirect call but no resolved target. No target edge is invented; in particular, there is no evidence connecting it to `helper.ts`. The registry initializer is empty at line 3; no registration appears in this file. This is static source evidence, not runtime execution proof.
- `helper.ts:2` calls the string built-in `value.trim()`. Built-ins are outside this module graph; absence of a built-in edge is not absence of a call expression.
- Only these five files were source inputs. No CODEBASE or project-memory grounding exists in this isolated fixture. The prompt's usual `/gsd codebase generate` suggestion is not executed because this probe's scope permits only these graph outputs.
- No AST extractor, external Graphify package, provider API, MCP tool, runtime handler, or third-party API was invoked. Import relationships, direct calls, and unresolved dynamic targets remain distinct.
