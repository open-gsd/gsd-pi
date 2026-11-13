# cmux-cua registry reproduction (source-only, partial)

This note documents what the source-only extractor can and cannot establish for the macOS cmux-cua tool registry. The extractor is a **new implementation**. It is not a recovery of the original, unpublished helper scripts, and it is not evidence for the historical full envelope digest.

## Pinned source

- Repository: `manaflow-ai/cmux-cua`
- Revision: `e0f738807dbff2f35fe67d7fbcc99c7082cffc23` (full SHA; commit date 2026-10-01).
- Files read: `libs/cmux-cua/rust/crates/platform-macos/src/tools/mod.rs` and `libs/cmux-cua/rust/crates/cmux-cua-core/src/tool.rs`.

## Two different claims, kept separate

| Claim | Value | Status |
| --- | --- | --- |
| Static registration sites in the macOS registry on the pinned revision | **37** (30 direct in `register_all`, 5 in `register_recording_tools`, 2 in `register_session_tools`) | Produced by this extractor on the pinned revision |
| Historical catalogue envelope tool count (author-only digest `6ec22e2d...`, 73,248 bytes) | **38** | **Not reproduced** |

The 37 is a count of static registration sites. It is not a runtime count and not the envelope count. The difference from 38 is not explained by this extractor. It is documented, not forced to match.

The value 37 is computed from the source at run time. It is not a hard-coded expectation and must not be treated as one for future revisions.

## What the extractor supports

It reads Rust source as text, after removing `//` and `/* */` comments:

- `registry.register(Box::new(<path>::<Type>...))` calls inside the brace-balanced body of `pub fn register_all`.
- Calls to `registry.register_<group>()` inside `register_all`, where the group body is found as a brace-balanced `fn <group>(...)` in `cmux-cua-core/src/tool.rs`, and counted by its `.register(` calls.
- `type_text_chars` is reported as registered only if a real `registry.register(Box::new(type_text_chars::...))` call exists. A type reference (for example `let _: &type_text_chars::TypeTextCharsTool = ...`) does not count.

## What the extractor does not support

- Tool schemas, descriptions, annotations and capabilities. Those are built by Rust code in `to_list_entry` and are not static text. Byte-exact reconstruction of the envelope digest therefore needs either executing that code (a native build, outside this source-only lane) or a faithful interpreter of it. This extractor claims neither.
- Dynamically built registrations (loops, conditionals, macros, or helper names it cannot resolve). Those are not counted. An unresolved group helper is an error, not a zero.
- Runtime state, permissions, or any live cmux-cua daemon.

## Failure behaviour (fail-closed)

| Condition | Exit | Output |
| --- | --- | --- |
| Required source file missing | 2 | `error: source files not found` |
| `register_all` body not found | 4 | `error: register_all body not found` |
| No direct registrations in `register_all` | 4 | `error: no direct registrations found in register_all` |
| A called group helper has no resolvable body | 3 | `error: unresolved helper body` |

A structure the extractor does not recognise is never reported as a valid zero.

## Reproduce the source-only count

```bash
git clone --filter=blob:none --no-checkout https://github.com/manaflow-ai/cmux-cua.git /tmp/cmux-cua-src
git -C /tmp/cmux-cua-src checkout e0f738807dbff2f35fe67d7fbcc99c7082cffc23
python3 scripts/cmux-cua/extract_registry.py /tmp/cmux-cua-src/libs/cmux-cua/rust/crates
```

Expected on the pinned revision: exit 0 and `"total_registrations_static": 37`. Tests: `node --test scripts/__tests__/cmux-cua-registry-extractor.test.mjs`.

## Limits

- Source-only. No native execution, no build, no signing or notarisation check.
- Fixture tests cover valid input, missing sources, unrecognised structure, unresolved helpers, comment handling, type-reference handling and determinism. They do not prove the pinned count beyond the single reproduction above.
