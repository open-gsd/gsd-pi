#!/usr/bin/env python3
import json, subprocess, base64, os, sys, time

NODE = "380967a0f0981e2301341ffec9b5df261e3e68892734d6dfadf6f45279886df0"
DIR = "/home/openclaw/.openclaw/projects/gsd-pi/context/mac-sessions"
STATUS = os.path.join(DIR, "transfer-status.json")
SESSIONS = [
    ("fc53a606-0455-4494-9513-88b6dfab3f2d", "openclaw-arch-redesign"),
    ("44cda857-2c6a-4d26-99c5-d493a22399f7", "gsd-pi-autoresearch"),
    ("218fc964-f6bd-4d82-95ad-9727d787df3f", "claude-runtime-compaction"),
    ("eb0485fb-9952-48cb-99f9-7e65c9e9e406", "openclaw-fork-deletion"),
    ("cdd2c26c-9564-4a4d-a68b-83bfd0773c42", "repo-setup-gsd-init"),
    ("39fb8d32-c023-415e-847e-54521c9c0c68", "openclaw-deploy-status"),
    ("a8bab9ba-5171-4458-90e5-7cfa27e40f1e", "codex-project-context"),
]

def write_status(d):
    with open(STATUS, "w") as f:
        json.dump(d, f)

def invoke_read(tid, cursor):
    params = {"threadId": tid}
    if cursor:
        params["cursor"] = cursor
    r = subprocess.run(
        ["openclaw", "nodes", "invoke", "--node", NODE,
         "--command", "anthropic.claude.sessions.read.v1",
         "--params", json.dumps(params), "--json", "--invoke-timeout", "20000"],
        capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"invoke failed rc={r.returncode}: {r.stderr[-300:]}")
    out = json.loads(r.stdout)
    payload = out.get("payload", out)
    return payload

def b64offset(resume_cursor):
    try:
        raw = base64.b64decode(resume_cursor + "==").decode()
        return json.loads(raw).get("offset")
    except Exception:
        return None

def text_of(item):
    if isinstance(item.get("text"), str):
        return item["text"]
    parts = []
    for c in item.get("content") or []:
        if isinstance(c, dict) and isinstance(c.get("text"), str):
            parts.append(c["text"])
    return "\n".join(parts)

def transfer(tid, label):
    final = os.path.join(DIR, label + ".jsonl")
    state_p = os.path.join(DIR, "." + label + ".xstate")
    cursor = None
    if os.path.exists(state_p):
        with open(state_p) as f:
            st = json.load(f)
        if st.get("done"):
            return "skipped-done"
        cursor = st.get("cursor")
    out = open(final, "a")
    windows, msgs = 0, 0
    try:
        while True:
            payload = invoke_read(tid, cursor)
            for it in payload.get("items") or []:
                t = it.get("type") or ""
                if t not in ("userMessage", "agentMessage"):
                    continue
                text = text_of(it)
                if not text:
                    continue
                line = json.dumps({"off": b64offset(it.get("resumeCursor")), "ts": it.get("timestamp"), "type": t, "text": text})
                out.write(line + "\n")
                msgs += 1
            windows += 1
            cursor = payload.get("nextCursor")
            if windows % 5 == 0:
                out.flush()
                with open(state_p, "w") as f:
                    json.dump({"cursor": cursor, "windows": windows, "msgs": msgs}, f)
                write_status({"phase": label, "windows": windows, "msgs": msgs, "done": False})
            if not cursor:
                break
    finally:
        out.close()
    with open(state_p, "w") as f:
        json.dump({"done": True, "windows": windows, "msgs": msgs}, f)
    return f"done windows={windows} msgs={msgs}"

results = {}
for tid, label in SESSIONS:
    try:
        results[label] = transfer(tid, label)
        write_status({"phase": label, "done": True, "results": results})
    except Exception as e:
        results[label] = f"ERROR: {e}"
        write_status({"phase": label, "error": str(e)[:300], "results": results})
        time.sleep(30)
write_status({"phase": "all-done", "done": True, "results": results})
print(json.dumps(results, indent=1))

