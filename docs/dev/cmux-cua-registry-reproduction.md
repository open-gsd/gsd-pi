# cmux-cua registry reproduction (source-only, partial)

This note documents what a source-only reproduction of the macOS cmux-cua tool registry can and cannot establish. It supersedes nothing: the historical catalogue digest recorded in `docs/dev/cmux-cua-catalogue-provenance.md` remains author-only and is not independently reproduced here.

## Pinned source

- Repository: `manaflow-ai/cmux-cua`
- Revision: `e0f738807dbff2f35fe67d7fbcc99c7082cffc23` (verified: commit date 2026-10-01, subject "feat: allow configurable unrestricted get_app_state").
- Files read: `libs/cmux-cua/rust/crates/platform-macos/src/tools/mod.rs`, `libs/cmux-cua/rust/crates/cmux-cua-core/src/tool.rs`.

## What the extractor establishes

`scripts/cmux-cua/extract_registry.py` reads those two files and counts static tool registrations. On the pinned revision it reports:

| Source | Count |
| --- | --- |
| Direct `registry.register(...)` in macOS `register_all` | 30 |
| `register_recording_tools` body | 5 |
| `register_session_tools` body | 2 |
| **Total static registrations** | **37** |
| `type_text_chars` registered | no (intentional deprecated alias) |

The total is a static count of registration sites. It is not a runtime count, and it is not the envelope tool count.

## What the extractor does NOT establish

- **The historical digest `6ec22e2d...` (73,248 bytes, 38 tools) is not reproduced.** The envelope is built by `to_list_entry` in Rust, from `name`, `description`, `inputSchema`, `annotations` and `capabilities`. Those values are produced by code, not stored as static text. Byte-exact reproduction requires executing that Rust code or a faithful interpreter, which is a native build. This is out of scope for the source-only lane.
- The static count (37) differs from the historical envelope count (38). The difference is not explained by this extractor and must not be forced to match.
- No runtime behaviour, permission state, or live cmux-cua daemon was observed.

## Reproduce the source-only count

```bash
git clone --filter=blob:none --no-checkout https://github.com/manaflow-ai/cmux-cua.git /tmp/cmux-cua-src
git -C /tmp/cmux-cua-src checkout e0f738807dbff2f35fe67d7fbcc99c7082cffc23
python3 scripts/cmux-cua/extract_registry.py /tmp/cmux-cua-src/libs/cmux-cua/rust/crates
```

Expected JSON contains `"total_registrations_static": 37`. Tests: `node --test scripts/__tests__/cmux-cua-registry-extractor.test.mjs`.

## Limits

- Source-only; no native execution, no build, no signing check.
- Fixture tests cover valid input, missing sources, determinism and non-hardcoding. They do not prove the pinned revision's count beyond the single reproduction above.
