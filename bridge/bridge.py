#!/usr/bin/env python3
"""Debug bridge between the Chrome extension and Claude Code.

The extension POSTs each analysis request (screenshot + context) to /analyze.
The bridge saves it to data/inbox/<id>.jpg + <id>.json and holds the HTTP request open
until an answer appears in data/outbox/<id>.json (written by Claude Code via cli.py),
then returns that answer to the extension. Standard library only.

In Claude API mode the extension can POST a copy of each finished turn (request + the API's
answer) to /mirror; it is only recorded in data/mirror/ so a run can be watched (cli.py mirror).

    python3 bridge/bridge.py [--port 8765]
"""
import argparse
import base64
import json
import re
import shutil
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
INBOX, OUTBOX, ARCHIVE, MIRROR = DATA / "inbox", DATA / "outbox", DATA / "archive", DATA / "mirror"
KEEP_ARCHIVED = 200
KEEP_MIRRORED = 400  # files (2 per turn)
lock = threading.Lock()


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def archive(rid, tag):
    dest = ARCHIVE / rid
    dest.mkdir(parents=True, exist_ok=True)
    for d in (INBOX, OUTBOX):
        for f in d.glob(f"{rid}.*"):
            shutil.move(str(f), str(dest / f"{d.name}-{f.name}"))
    (dest / "status.txt").write_text(tag, encoding="utf-8")
    old = sorted(ARCHIVE.iterdir(), key=lambda p: p.stat().st_mtime)[:-KEEP_ARCHIVED]
    for p in old:
        shutil.rmtree(p, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            log("client went away before the answer was delivered")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            pending = [f.stem for f in sorted(INBOX.glob("*.json"))]
            return self._send(200, {"ok": True, "pending": pending})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        # An error in here must answer, not drop the connection (the extension only sees "Failed to fetch").
        try:
            self.handle_post()
        except Exception as e:
            log(f"ERROR {self.path}: {e!r}")
            self._send(500, {"ok": False, "error": f"bridge error: {e!r}"})

    def handle_post(self):
        if not self.path.startswith(("/analyze", "/mirror")):
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except (ValueError, json.JSONDecodeError):
            return self._send(400, {"ok": False, "error": "bad json"})
        if self.path.startswith("/mirror"):
            return self.mirror(req)

        rid = re.sub(r"[^A-Za-z0-9_-]", "", str(req.get("id") or int(time.time() * 1000)))
        img = req.pop("image", {}) or {}
        b64 = img.pop("base64", None)
        with lock:
            # The extension waits on one request at a time: anything still pending is stale.
            for f in INBOX.glob("*.json"):
                archive(f.stem, "superseded")
                log(f"superseded {f.stem}")
            jpg = INBOX / f"{rid}.jpg"
            if b64:
                jpg.write_bytes(base64.b64decode(b64))
            req["image"] = {**img, "file": str(jpg)}
            tmp = INBOX / f"{rid}.json.tmp"
            tmp.write_text(json.dumps(req, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(INBOX / f"{rid}.json")  # json last: a visible .json means the pair is complete
        events = len(req.get("events") or [])
        log(f"NEW {rid} · {req.get('page', {}).get('title', '')[:60]} · events={events}")

        timeout = min(float(req.get("timeoutSec") or 900), 3600)
        deadline = time.time() + timeout
        out = OUTBOX / f"{rid}.json"
        while time.time() < deadline:
            if out.exists():
                try:
                    result = json.loads(out.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    time.sleep(0.3)
                    continue
                with lock:
                    archive(rid, "answered")
                log(f"ANSWERED {rid} · {len(result.get('actions', []))} actions · {result.get('summary', '')[:80]}")
                return self._send(200, {"ok": True, "result": result})
            if not (INBOX / f"{rid}.json").exists():
                return self._send(200, {"ok": False, "error": "superseded"})
            time.sleep(0.4)
        with lock:
            archive(rid, "timeout")
        log(f"TIMEOUT {rid}")
        self._send(200, {"ok": False, "error": "timeout"})


    def mirror(self, req):
        rid = re.sub(r"[^A-Za-z0-9_-]", "", str(req.get("id") or int(time.time() * 1000)))
        img = req.pop("image", {}) or {}
        b64 = img.pop("base64", None)
        with lock:
            jpg = MIRROR / f"{rid}.jpg"
            if b64:
                jpg.write_bytes(base64.b64decode(b64))
            req["image"] = {**img, "file": str(jpg)}
            (MIRROR / f"{rid}.json").write_text(json.dumps(req, indent=2, ensure_ascii=False), encoding="utf-8")
            for f in sorted(MIRROR.iterdir(), key=lambda p: p.stat().st_mtime)[:-KEEP_MIRRORED]:
                f.unlink(missing_ok=True)
        res, use = req.get("result") or {}, req.get("usage") or {}
        acts = ", ".join(a.get("type", "?") for a in res.get("actions", [])) or "no actions"
        log(f"API {rid} · in={use.get('input_tokens', '?')} out={use.get('output_tokens', '?')} · {acts} · {res.get('summary', '')[:80]}")
        self._send(200, {"ok": True})


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets a second bridge bind the same port and silently take some of the
    # requests (an old bridge with old code answered the screenshots). Refuse to share the port there.
    allow_reuse_address = sys.platform != "win32"


def main():
    # Titles and prompts hold "–", "→", emoji…: on Windows the console/log code page (cp1252) can't print
    # them, and a failing log() inside a request handler drops the connection ("Failed to fetch").
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    for d in (INBOX, OUTBOX, ARCHIVE, MIRROR):
        d.mkdir(parents=True, exist_ok=True)
    try:
        srv = Server((a.host, a.port), Handler)
    except OSError as e:
        log(f"port {a.port} is in use ({e}) - another bridge is probably running already; stop it first")
        sys.exit(1)
    srv.daemon_threads = True
    log(f"bridge listening on http://{a.host}:{a.port}  (data: {DATA})")
    # "localhost" may resolve to IPv6 ::1 in Chrome: answer there too when the default host is used.
    if a.host == "127.0.0.1":
        try:
            class V6Server(Server):
                address_family = socket.AF_INET6
            srv6 = V6Server(("::1", a.port), Handler)
            srv6.daemon_threads = True
            threading.Thread(target=srv6.serve_forever, daemon=True).start()
            log(f"bridge also listening on http://[::1]:{a.port} (localhost)")
        except OSError as e:
            log(f"IPv6 localhost not available ({e}) - use http://127.0.0.1:{a.port} in Settings")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
