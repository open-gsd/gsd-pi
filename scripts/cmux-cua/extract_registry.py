#!/usr/bin/env python3
"""Source-only extractor for the macOS cmux-cua tool registry.

Reads Rust source at a pinned checkout and counts STATIC registration sites.
It does not execute the native binary, does not build, and does not
reconstruct the runtime envelope (tool schemas are built by Rust code).

Fail-closed: a missing source file, a missing `register_all` body, zero
direct registrations, or an unresolved helper body is an error (non-zero
exit). A structure we do not recognise is never reported as a valid zero.
"""
import json
import re
import sys
from pathlib import Path

EXIT_OK, EXIT_MISSING_SOURCE, EXIT_UNRESOLVED, EXIT_UNRECOGNISED = 0, 2, 3, 4


def strip_comments(text):
    """Blank out comments and string literals so they never produce matches.

    Replaces every character of a comment or string literal with a space
    (newlines kept), so brace matching and positions stay meaningful.
    """
    out, i, n = [], 0, len(text)
    while i < n:
        two = text[i : i + 2]
        if two == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif two == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join("\n" if c == "\n" else " " for c in text[i:j]))
            i = j
        elif text[i] == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            j = min(j + 1, n)
            out.append("".join("\n" if c == "\n" else " " for c in text[i:j]))
            i = j
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def fn_body(text, signature_regex):
    """Return the brace-balanced body of the first fn matching signature_regex, or None."""
    m = re.search(signature_regex, text)
    if not m:
        return None
    start = text.find("{", m.end())
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : i]
    return None


def fail(code, payload):
    print(json.dumps(payload))
    return code


def main(root):
    root = Path(root)
    mod_path = root / "platform-macos/src/tools/mod.rs"
    tool_path = root / "cmux-cua-core/src/tool.rs"
    if not mod_path.exists() or not tool_path.exists():
        return fail(EXIT_MISSING_SOURCE, {"error": "source files not found", "root": str(root)})

    mod_src = strip_comments(mod_path.read_text(encoding="utf-8"))
    core_src = strip_comments(tool_path.read_text(encoding="utf-8"))

    register_all = fn_body(mod_src, r"pub fn register_all\s*\(")
    if register_all is None:
        return fail(EXIT_UNRECOGNISED, {"error": "register_all body not found", "root": str(root)})

    direct = re.findall(r"registry\.register\(Box::new\(\s*([A-Za-z_][A-Za-z0-9_:]*)", register_all)
    if not direct:
        return fail(EXIT_UNRECOGNISED, {"error": "no direct registrations found in register_all", "root": str(root)})

    groups = re.findall(r"registry\.(register_[a-z_]+)\(\)", register_all)
    group_counts, unresolved = {}, []
    for g in groups:
        body = fn_body(core_src, r"fn " + g + r"\s*\(")
        if body is None:
            unresolved.append(g)
        else:
            group_counts[g] = len(re.findall(r"\.register\(", body))
    if unresolved:
        return fail(EXIT_UNRESOLVED, {"error": "unresolved helper body", "unresolved": unresolved, "root": str(root)})

    report = {
        "root": str(root),
        "direct_registrations_in_macos_register_all": len(direct),
        "group_calls": groups,
        "group_bodies": group_counts,
        "type_text_chars_registered": bool(re.search(r"registry\.register\(Box::new\(\s*type_text_chars::", register_all)),
        "total_registrations_static": len(direct) + sum(group_counts.values()),
    }
    print(json.dumps(report, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
