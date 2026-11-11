# cmux-cua catalogue provenance (source-derived)

Status: source-derived provenance only. This document does not accept a native or runtime catalogue, does not authorize installation, and does not change the runtime pin.

## Pinned source

- Repository: `manaflow-ai/cmux-cua`
- Revision: `e0f738807dbff2f35fe67d7fbcc99c7082cffc23`
- Producer: `crates/cmux-cua-core/src/tool.rs` (`tools_list` envelope, `schema_version` emitted at line 593 as the string `"1"`)

## Counts (actual, not padded)

| Measure | Count | Anchor |
| --- | --- | --- |
| ToolDef literal definitions | 39 | `crates/cmux-cua-core/src/*` and `platform-macos/src/tools/*` |
| macOS platform registrations (non-Codex) | 37 | `platform-macos/src/tools/mod.rs:626-680` |
| CLI advertised entries | 38 | `crates/cmux-cua/src/main.rs:154-172` |
| Envelope tools in `tools/list` | 38 | `tool.rs:573-595` |
| Unregistered deprecated alias | `type_text_chars` | `platform-macos/src/tools/mod.rs:670-677` |

The envelope contains 38 tools because the deprecated alias is unregistered; the 39th literal is not advertised.

## Envelope reproduction (source-only, no native execution)

The reproduction reads only downloaded source files at the pinned revision. It does not execute the native binary and does not build locally. Run it from a directory containing the pinned source snapshot and the helper scripts `extract.py` and `verify-roster.py` (currently unpublished; see the limit below).

Reference command (NOT runnable as published: it requires the unpublished helper scripts `extract.py` and `verify-roster.py`, so it documents the author's procedure only and is not a reproduction a maintainer can execute):

```text
python3 - <<'PY'
from pathlib import Path
import hashlib, json
r = Path('/path/to/cmux-cua-source-snapshot')  # pinned e0f738807dbff2f35fe67d7fbcc99c7082cffc23
g = {'__file__': str(r / 'extract.py')}
exec((r / 'extract.py').read_text().split("print('literal definitions'")[0], g)
assert not g['errors']
g.update(R=r, C=r / 'crates', defs=g['DEFS'])
v = (r / 'verify-roster.py').read_text()
exec(v[v.index('def regs('):v.index('\nresult=')], g)
g['envelope']['schema_version'] = '1'
b = json.dumps(g['envelope'], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
print(hashlib.sha256(b).hexdigest(), len(b), 'tools', len(g['envelope']['tools']))
PY
```

Recorded author output (not independently verified): `6ec22e2dd71ff5716905e491f85fdc20403bbe7e367d37a03234231b6aa8aaf1 73248 tools 38`.

Tool selection: the macOS registry (`platform-macos/src/tools/mod.rs` `register_all`, plus `check_for_update`), with the unregistered `type_text_chars` alias excluded. Array order follows registration order. Entry conversion: each tool is emitted as `name`, `description`, `inputSchema`, `annotations` (four booleans), and `capabilities`.

**Not independently reproducible yet.** The helper scripts `extract.py` and `verify-roster.py` are not published in this repository or upstream. A maintainer cannot run the command above from upstream alone, so the digest is recorded as source-derived provenance by the author only, not as a verifiable reproduction. Publishing those helpers as a versioned, reviewed artifact is a prerequisite before this digest can be treated as reproducible.

- Output length: 73,248 bytes
- SHA256: `6ec22e2dd71ff5716905e491f85fdc20403bbe7e367d37a03234231b6aa8aaf1`
- Encoding: sorted keys, compact UTF-8 JSON, no trailing newline, preserved tool-array order. This is not RFC 8785 and makes no claim about native transport byte formatting.

## Limits

- The digest proves source-derived content only. It is not runtime evidence.
- The runtime/embedded host catalogue remains unknown; the existing runtime expectation is unchanged.
- No local install, build, helper invocation, or native click/type/screenshot was performed.
- `G03_RUNTIME_ADMISSION_ENABLED` remains literally `false`.
