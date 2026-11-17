"""Wake Claude Code for each bridge request (bridge.py --wake-claude).

The bridge calls wake(rid) when a request arrives. One headless run at a time (`claude -p`, only the
Read tool for the screenshot) gets the request's system prompt and per-turn text - exactly what the
Claude API gets in API mode - and prints the JSON answer. The bridge validates it and writes it to the
outbox like cli.py respond. When the run exits nothing runs (and nothing costs) until the next request.

session "one" (default): every run resumes the same Claude Code session (id in data/wake_session.txt,
kept across bridge restarts; delete the file to start a new one), so it sees all its earlier turns.
The context grows with every request; Claude Code compacts it when it gets full.
session "request": a fresh, unsaved session per request (cheapest).

    python3 bridge/wake.py ID    dry run on a pending or archived request: print the answer, deliver nothing
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cli import validate  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"
INBOX, OUTBOX, ARCHIVE = DATA / "inbox", DATA / "outbox", DATA / "archive"
SESSION_FILE = DATA / "wake_session.txt"

ANSWER_RULE = """

# How to answer (bridge)
The screenshot of this turn is a file: view it with the Read tool before deciding (its path is at the end of
the message). Then reply with only the JSON answer object - no prose, no code fences."""


def find_claude(path=None):
    if path:
        return path
    found = shutil.which("claude")
    if found:
        return found
    # The VS Code extension bundles the CLI without putting it on PATH: take the newest one.
    pat = os.path.expanduser("~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude*")
    bins = sorted(glob.glob(pat), key=os.path.getmtime)
    return bins[-1] if bins else None


def load(rid):
    p = INBOX / f"{rid}.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    req = json.loads((ARCHIVE / rid / f"inbox-{rid}.json").read_text(encoding="utf-8"))  # dry run
    req.setdefault("image", {})["file"] = str(ARCHIVE / rid / f"inbox-{rid}.jpg")
    return req


def extract(text):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e < s:
        raise ValueError("no JSON object in the reply")
    return validate(json.loads(text[s:e + 1]))


def session_id():
    try:
        return SESSION_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def ask(claude, req, model, timeout, log, session="request"):
    img = req.get("image", {})
    prompt = f"{req.get('prompt', '')}\n\nSCREENSHOT: {img.get('file')} ({img.get('width')}x{img.get('height')})"
    cmd = [claude, "-p", "--output-format", "json", "--model", model,
           "--system-prompt", req.get("system", "") + ANSWER_RULE,
           "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "dontAsk",
           "--safe-mode", "--strict-mcp-config"]
    sid = new = None
    if session == "one":
        # Snapshot off: a Job edited in Settings reaches the shared session at its next request.
        cmd += ["--system-prompt-snapshot", "off"]
        sid = session_id()
        if sid:
            cmd += ["--resume", sid]
        else:
            sid = new = str(uuid.uuid4())
            cmd += ["--session-id", sid]
    else:
        cmd += ["--no-session-persistence"]
    t0 = time.time()
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout, cwd=str(DATA))
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        if sid and not new:  # the saved session is gone or broken: the next try starts a new one
            SESSION_FILE.unlink(missing_ok=True)
            log(f"WAKE session {sid} could not be resumed - the next try starts a new one")
        raise RuntimeError(f"claude exited {p.returncode}: {(p.stderr or p.stdout).strip()[:300]}")
    if new:
        SESSION_FILE.write_text(new, encoding="utf-8")
        log(f"WAKE new session {new}")
    cost, use = out.get("total_cost_usd"), out.get("usage") or {}
    ctx = sum(use.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    log(f"WAKE run done in {time.time() - t0:.0f}s" + (f" · ${cost:.4f}" if cost is not None else "")
        + (f" · context {ctx} tokens" if ctx else ""))
    if out.get("is_error"):
        raise RuntimeError(f"claude error: {str(out.get('result'))[:300]}")
    return extract(out.get("result") or "")


class Waker:
    """One Claude Code run at a time, always for the newest pending request."""

    def __init__(self, log, claude=None, model="sonnet", timeout=300, tries=2, session="one"):
        self.log, self.model, self.timeout, self.tries, self.session = log, model, timeout, tries, session
        self.claude = find_claude(claude)
        if not self.claude:
            raise SystemExit("--wake-claude: Claude Code not found (install it or pass --claude PATH)")
        self.cv = threading.Condition()
        self.want = None
        threading.Thread(target=self.loop, daemon=True).start()

    def wake(self, rid):
        with self.cv:
            self.want = rid
            self.cv.notify()

    def loop(self):
        while True:
            with self.cv:
                while not self.want:
                    self.cv.wait()
                rid, self.want = self.want, None
            self.run(rid)

    def live(self, rid):
        return (INBOX / f"{rid}.json").exists() and not (OUTBOX / f"{rid}.json").exists()

    def run(self, rid):
        for n in range(1, self.tries + 1):
            if not self.live(rid) or self.want:  # answered, superseded, or a newer one is waiting
                return
            self.log(f"WAKE {rid} · try {n} · {self.model}")
            try:
                ans = ask(self.claude, load(rid), self.model, self.timeout, self.log, self.session)
            except Exception as e:  # noqa: BLE001 - a failed run is retried, never kills the bridge
                self.log(f"WAKE {rid} failed: {e}")
                continue
            if not self.live(rid):
                return self.log(f"WAKE {rid} answered too late (no longer pending)")
            tmp = OUTBOX / f"{rid}.json.tmp"
            tmp.write_text(json.dumps(ans, ensure_ascii=False), encoding="utf-8")
            tmp.replace(OUTBOX / f"{rid}.json")
            return
        self.log(f"WAKE {rid} gave up after {self.tries} tries - answer it with cli.py respond, or it times out")


if __name__ == "__main__":
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")
    model = sys.argv[2] if len(sys.argv) > 2 else "sonnet"
    print(json.dumps(ask(find_claude(), load(sys.argv[1]), model, 300, print), ensure_ascii=False, indent=2))
