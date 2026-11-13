#!/usr/bin/env python3
"""Generic, source-only extractor for the macOS cmux-cua tool registry.

Reads Rust source at a pinned checkout and counts tool registrations.
It does not execute the native binary and does not build anything.
Output is a JSON report of registration sites, not a fixed expected number.
"""
import json, re, sys
from pathlib import Path

def registrations(text):
    # direct: registry.register(Box::new(<path>::<Type>...))
    direct = re.findall(r"registry\.register\(Box::new\(([A-Za-z_:][A-Za-z0-9_:]*)", text)
    # helper groups: registry.register_<group>_tools() / _session_tools()
    groups = re.findall(r"registry\.(register_[a-z_]+)\(\)", text)
    return direct, groups

def main(root):
    root = Path(root)
    mod = root / "platform-macos/src/tools/mod.rs"
    tool = root / "cmux-cua-core/src/tool.rs"
    if not mod.exists() or not tool.exists():
        print(json.dumps({"error": "source files not found", "root": str(root)}))
        return 2
    direct, groups = registrations(mod.read_text(encoding="utf-8"))
    core = tool.read_text(encoding="utf-8")
    report = {
        "root": str(root),
        "direct_registrations_in_macos_register_all": len(direct),
        "group_calls": groups,
        "group_bodies": {},
        "type_text_chars_registered": bool(re.search(r"registry\.register\(Box::new\(\s*type_text_chars::", mod.read_text(encoding="utf-8"))),
    }
    unresolved = []
    for g in groups:
        m = re.search(r"fn " + g + r"\(&mut self\)\s*\{(.*?)\n    \}", core, re.S)
        if not m:
            unresolved.append(g)
            continue
        report["group_bodies"][g] = len(re.findall(r"\.register\(", m.group(1)))
    if unresolved:
        print(json.dumps({"error": "unresolved helper body", "unresolved": unresolved, "root": str(root)}))
        return 3
    report["total_registrations_static"] = report["direct_registrations_in_macos_register_all"] + sum(v or 0 for v in report["group_bodies"].values())
    print(json.dumps(report, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
