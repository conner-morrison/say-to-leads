#!/usr/bin/env python3
"""Claude Code side of the debug bridge.

    python3 bridge/cli.py wait [--timeout SEC]   block until a request is pending, then show it
    python3 bridge/cli.py list                   list pending request ids
    python3 bridge/cli.py show [ID]              show a request (default: newest pending)
    python3 bridge/cli.py respond ID JSON        answer it (JSON string, @file, or - for stdin; ID may be 'latest')
    python3 bridge/cli.py mirror [N]             last N turns of a Claude API run (mirrored, read-only)
"""
import argparse
import json
import sys
import time
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
INBOX, OUTBOX, MIRROR = DATA / "inbox", DATA / "outbox", DATA / "mirror"

# Keep in sync with extension/lib/schema.js
ACTION_TYPES = {"click", "double_click", "hover", "type", "key", "scroll", "browse", "wait", "notify", "next", "pause", "stop"}


def pending():
    # An answered request stays in the inbox until the bridge picks the answer up; skip it.
    reqs = [p for p in INBOX.glob("*.json") if not (OUTBOX / p.name).exists()]
    return sorted(reqs, key=lambda p: p.stat().st_mtime)


def resolve(rid):
    if rid in (None, "latest"):
        p = pending()
        if not p:
            sys.exit("no pending request")
        return p[-1].stem
    return rid


def show(rid):
    req = json.loads((INBOX / f"{rid}.json").read_text())
    img = req.get("image", {})
    vp = req.get("page", {}).get("viewport", {})
    print(f"REQUEST {rid}")
    print(f"IMAGE   {img.get('file')}  ({img.get('width')}x{img.get('height')}, viewport {vp.get('w')}x{vp.get('h')})")
    print("-" * 70)
    print(req.get("prompt", ""))
    print("-" * 70)
    print(f"Answer with: python3 bridge/cli.py respond {rid} '<json>'")


def mirror(n):
    turns = sorted(MIRROR.glob("*.json"), key=lambda p: p.stat().st_mtime)[-n:]
    if not turns:
        print("nothing mirrored yet (Claude API mode with 'Mirror turns to the bridge' on)")
    for p in turns:
        t = json.loads(p.read_text())
        res, use = t.get("result") or {}, t.get("usage") or {}
        when = time.strftime("%H:%M:%S", time.localtime((t.get("created") or 0) / 1000))
        print(f"=== {p.stem} {when} · {t.get('model', '')} · {t.get('page', {}).get('title', '')[:50]}")
        print(f"    image  {t.get('image', {}).get('file')}")
        print(f"    tokens in={use.get('input_tokens')} cache_read={use.get('cache_read_input_tokens')} "
              f"cache_write={use.get('cache_creation_input_tokens')} out={use.get('output_tokens')}")
        if t.get("error"):
            print(f"    ERROR  {t['error']}")
        print(f"    said   {res.get('summary', '')}")
        for a in res.get("actions", []):
            print(f"    -> {json.dumps(a, ensure_ascii=False)}")
        if res.get("inbox"):
            print(f"    inbox  {json.dumps(res['inbox'], ensure_ascii=False)}")


def validate(obj):
    if not isinstance(obj, dict):
        raise ValueError("answer must be a JSON object")
    obj.setdefault("summary", "")
    obj.setdefault("actions", [])
    obj.setdefault("next_check_sec", None)
    if not isinstance(obj["actions"], list):
        raise ValueError("actions must be a list")
    for i, a in enumerate(obj["actions"]):
        if not isinstance(a, dict) or a.get("type") not in ACTION_TYPES:
            raise ValueError(f"action {i}: type must be one of {sorted(ACTION_TYPES)}")
        if a["type"] in ("click", "double_click", "hover") and not (
            "selector" in a or "box" in a or ("x" in a and "y" in a)
        ):
            raise ValueError(f"action {i}: {a['type']} needs box, x/y or selector")
        if "box" in a and (not isinstance(a["box"], list) or len(a["box"]) != 4):
            raise ValueError(f"action {i}: box must be [x1,y1,x2,y2]")
    ib = obj.get("inbox")
    if ib is not None and not (isinstance(ib, dict) and isinstance(ib.get("top"), str)):
        raise ValueError('inbox must be {"top": str, "unread": [...], "accepted": [...]}')
    n = obj["next_check_sec"]
    if n is not None and not isinstance(n, (int, float)):
        raise ValueError("next_check_sec must be a number or null")
    return obj


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("wait")
    w.add_argument("--timeout", type=float, default=600)
    sub.add_parser("list")
    s = sub.add_parser("show")
    s.add_argument("id", nargs="?")
    r = sub.add_parser("respond")
    r.add_argument("id")
    r.add_argument("answer")
    m = sub.add_parser("mirror")
    m.add_argument("n", nargs="?", type=int, default=5)
    a = ap.parse_args()
    INBOX.mkdir(parents=True, exist_ok=True)
    OUTBOX.mkdir(parents=True, exist_ok=True)

    if a.cmd == "wait":
        end = time.time() + a.timeout
        while time.time() < end:
            if pending():
                return show(resolve("latest"))
            time.sleep(0.5)
        print("no request within timeout")
        sys.exit(2)
    if a.cmd == "mirror":
        return mirror(a.n)
    if a.cmd == "list":
        for p in pending():
            print(p.stem)
        return
    if a.cmd == "show":
        return show(resolve(a.id))
    if a.cmd == "respond":
        rid = resolve(a.id)
        if not (INBOX / f"{rid}.json").exists():
            sys.exit(f"{rid} is not pending (answered, superseded or timed out)")
        raw = sys.stdin.read() if a.answer == "-" else Path(a.answer[1:]).read_text() if a.answer.startswith("@") else a.answer
        try:
            obj = validate(json.loads(raw))
        except (ValueError, json.JSONDecodeError) as e:
            sys.exit(f"invalid answer: {e}")
        tmp = OUTBOX / f"{rid}.json.tmp"
        tmp.write_text(json.dumps(obj, ensure_ascii=False))
        tmp.replace(OUTBOX / f"{rid}.json")
        print(f"delivered {rid}: {len(obj['actions'])} actions")


if __name__ == "__main__":
    main()
