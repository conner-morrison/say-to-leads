# Say To Leads – notes for Claude Code

Chrome MV3 extension (`extension/`) that automates one linked tab with human-like pacing,
plus a local debug bridge (`bridge/`, Python stdlib) so Claude Code can be the "AI" during
development. Later the analyzer is switched to the Claude API (`analyzer.mode = 'anthropic'`).

## Debug loop (Claude Code acting as the analyzer)

1. Bridge must be running: `python3 bridge/bridge.py` (user usually starts it in a terminal;
   otherwise start it with `run_in_background`).
2. Wait for a request: `python3 bridge/cli.py wait --timeout 600`
   It prints the request id, the screenshot path, and the full prompt (job, page, events, history).
3. Look at the screenshot with the Read tool (`bridge/data/inbox/<id>.jpg`).
4. Decide per the JOB text, then answer:
   `python3 bridge/cli.py respond <id> '<json>'` (or `respond latest -` with JSON on stdin).
5. Repeat. Only the newest request is live; older ones are auto-archived as superseded.
   The extension waits up to `analyzer.bridgeTimeoutSec` (default 900s) per request.

## Answer format (must match `extension/lib/schema.js`)

```json
{
  "summary": "Inbox shows 1 new lead from Anna; opening it.",
  "actions": [
    {"type": "click", "box": [0.02, 0.31, 0.30, 0.36]},
    {"type": "type", "box": [0.35, 0.90, 0.95, 0.95], "text": "Hi Anna, thanks for reaching out!"},
    {"type": "key", "key": "Enter"},
    {"type": "notify", "text": "Replied to Anna", "photo": false}
  ],
  "next_check_sec": 5
}
```

- Coordinates are normalized to the screenshot (0..1, origin top-left). Prefer `box`
  (whole target) – the extension picks a human-like point inside it. `x`/`y` and `selector` also work.
- Types: click, double_click, hover, type (optional target, `clear`), key (`Enter`, `Escape`,
  `Ctrl+A`…), scroll (`dy` px), wait (`ms`), notify (Telegram, `photo`), pause, stop.
- Keep 0–5 actions per turn and verify on the next screenshot. `"\n"` in `type` text is sent as
  Shift+Enter (newline without sending). Use `key: Enter` to send.
- Empty `actions` is a valid answer ("nothing to do").

## Layout

- `extension/background.js` – engine: loop, change detection, schedule/breaks, Telegram commands.
- `extension/lib/` – `human.js` (timing, mouse paths, typing/typos), `input.js` (CDP vs DOM backends +
  humanizing layer), `capture.js`, `analyzer.js`, `schema.js`, `telegram.js`, `settings.js`, `profiles.js`.
- `extension/content/` – page-side watchers (title counter, selectors, web notifications), DOM driver, debug cursor.
- When changing the action schema, update `schema.js`, `bridge/cli.py` (`ACTION_TYPES`) and this file together.
