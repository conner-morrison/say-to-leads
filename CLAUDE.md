# Say To Leads – notes for Claude Code

Chrome MV3 extension (`extension/`) that automates one linked tab with human-like pacing,
plus a local debug bridge (`bridge/`, Python stdlib) so Claude Code can be the "AI" during
development. Later the analyzer is switched to the Claude API (`analyzer.mode = 'anthropic'`).

## Debug loop (Claude Code acting as the analyzer)

1. Bridge must be running: `python3 bridge/bridge.py` (user usually starts it in a terminal;
   otherwise start it with `run_in_background`).
2. Wait for a request: `python3 bridge/cli.py wait --timeout 600`
   It prints the request id, the screenshot path, and the full prompt (feed position, page, events, history).
3. Look at the screenshot with the Read tool (`bridge/data/inbox/<id>.jpg`).
4. Decide per the job the user gave in chat (it is not in the prompt), then answer:
   `python3 bridge/cli.py respond <id> '<json>'` (or `respond latest -` with JSON on stdin).
5. Repeat. Only the newest request is live; older ones are auto-archived as superseded.
   The extension waits up to `analyzer.bridgeTimeoutSec` (default 900s) per request.

## Feed

Settings → Feed holds page URLs, one per line. Start opens nothing and does no job on its own; it
sends screenshots and, while idle, makes small humanized mouse drifts / scroll-and-back moves
(`human.idleMoveChance`, `human.idleScrollChance`). The first `next` action opens URL 1;
when the job on a page is done, answer `next` again for the following URL (history is reset per
page). After the last URL, `next` ends the run. The prompt's `FEED:` line shows `not opened yet` or
`page i of n – <url>`. With an empty feed the run works on whatever the linked tab shows.

Settings → First messages holds saved openers (`messages.first`); they appear in the prompt under
`SAVED FIRST MESSAGES` and are used only when the job asks for one. `SEND MODE` (`messages.sendMode`)
says whether to click Send (`auto`) or type, notify and pause for the human (`review`).

## Relay server (registration + URL trigger)

Settings → Registration registers the extension, under its own name, with a relay workspace
(default `https://relay-production-7643.up.railway.app/upwork`; client in `extension/lib/relay.js`).
Flow: `POST {url}/enrol {name,label}` → ticket → long-poll `GET {url}/enrol/{ticket}?wait=25` until an
admin approves (→ worker id; 404 = declined) → long-poll `GET {url}/messages?wait=25` with
`Authorization: Bearer <id>` → `POST {url}/ack {channel,seq}`. Status: none → pending → registered (no
channel) → ready (channel allocated; the server only reveals channels through messages/notices).
Settings → Feed & job → "URLs come from" (`task.source`): `server` or `urls` (the Settings list).

Server mode (leads = URL + name, parsed by `leadsIn` in relay.js):
- Start: leads left in the persistent FIFO queue (`relayQueue`) come first; if it is empty, fetch the next
  ≤10 messages (`GET /messages?limit=10`), queue their leads, reply `{"status":"fetched", url, name, job_id,
  reply_to}` to each in its channel (`POST /publish`, id `fetched:<channel>:<seq>:<i>`), then ack (cursor
  moves right after the last fetched). Nothing on the server → no run, status "watching".
- A queue head leaves the queue only when its page is done (`next`), so an error halt keeps it for the next
  Start. Queue empty → fetch again → none → run ends → watching.
- Nothing works until **Start**: the session (`state.session`: off → on → paused) is switched only by the
  popup buttons. Start → on (run the queue, else watch); Pause/Resume also pause/resume watching; Stop or an
  error alarm → off = idle (no watching, no auto-start). Popup status: idle · watching · running · paused ….
- Watching (session on, no run) = a long poll (`limit=1&wait=25`) used only as a trigger; any message/notice →
  fetch → auto-start. A running run ignores triggers (the watch loop is off).
- The lead's name goes to the AI as `LEAD FOR THIS PAGE`, so it is not read from the page.

## Inbox monitor

Every `monitor.inboxEveryMin` minutes (Settings → Inbox monitor, default 60, 0 = off) the next request
carries an `INBOX CHECK DUE` section with the previously seen top of the Messaging panel. Add to the
answer `"inbox": {"top": "<first non-Sponsored name in the list>", "unread": [blue bold names], "accepted": [names
above the previous top that are not unread]}` – the extension stores `top` and sends the Telegram note
itself. Leave `inbox` out (it stays due) if the panel is collapsed; open it instead.

## Claude API mode (production)

The job text lives in Settings → Feed & job → Job (`task.job`; the default is `extension/lib/job-default.js`,
a model-facing version of `jobs/linkedin-connect.md`, so keep the two in sync). It is sent as a cached
system block. The extension picks one random saved first message per page (`pickedMessage`).
To watch an API run, use `python3 bridge/cli.py mirror [N]` (turns are mirrored to `bridge/data/mirror/`
when `analyzer.mirrorToBridge` is on). Look at the screenshots and answers and report problems.
Never answer them; the API already did.

## Jobs

The job the user gives in chat is written down in `jobs/*.md` (e.g. `jobs/linkedin-connect.md`).
Follow the current one in the debug loop and add layout lessons learned from screenshots to it.

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
  `Ctrl+A`…), scroll (`dy` px), browse (reads the whole page by itself – random depths, pauses,
  back to top – with no screenshots; optional `sec`), connect (LinkedIn profile: the extension finds
  the header's Connect, or More → Connect, in the DOM and clicks it; the result note comes back in the next
  prompt), add_note / note (`text`) / send_invite (LinkedIn invitation modal, found in the DOM: Add a note –
  never "Send without a note" –, type into the note box with a character-count report, click Send), wait (`ms`), notify (Telegram, `photo`; `alert: "weekly_limit" | "linkedin_error"` marks an
  error alarm – the extension sends it if enabled and stops the run), next (page done → next feed
  URL; later actions are skipped; `outcome: sent | pending | error` counts toward the weekly summary that
  goes to Telegram when the weekly limit stops the run, then resets), pause, stop.
- Keep 0–5 actions per turn and verify on the next screenshot. `"\n"` in `type` text is sent as
  Shift+Enter (newline without sending). Use `key: Enter` to send.
- Empty `actions` is a valid answer ("nothing to do").

## Layout

- `extension/lib/cdpdom.js` – the invitation modal through the debugger (pierced tree: iframes, closed shadow
  roots) for add_note/note/send_invite, and `labelAt` – box clicks report the label hit and refuse forbidden buttons.
- `extension/.env` (gitignored; template `extension/.env.example`, read by `lib/env.js`) – per-PC API key,
  model, mode, bridge URL, Telegram token/chat, relay URL. They fill Settings fields left empty; saved values win.

- `extension/background.js` – engine: loop, change detection, schedule/breaks, Telegram commands.
- `extension/lib/` – `human.js` (timing, mouse paths, typing/typos), `input.js` (CDP vs DOM backends +
  humanizing layer), `capture.js`, `analyzer.js`, `schema.js`, `telegram.js`, `settings.js`, `profiles.js`.
- `extension/content/` – page-side watchers (title counter, selectors, web notifications), DOM driver, debug cursor.
- When changing the action schema, update `schema.js`, `bridge/cli.py` (`ACTION_TYPES`) and this file together.
