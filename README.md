# Say To Leads – Human Flow (template)

A Chrome extension that works one website tab the way a person would: it looks at the screen,
decides what to do, then moves the mouse, clicks, and types with human timing. It notices new
notifications and messages, and reports to you on Telegram.

```
┌─ Chrome extension ────────────────────────────────────────────┐
│ popup: Link tab · Start · Pause · Resume · Stop · live log    │
│ engine loop:                                                  │
│   screenshot → tiny-thumbnail diff ─ unchanged → idle/fidget  │
│                 └ changed / new event / stale → ANALYZER      │
│   actions → human input (bezier mouse, typos, think pauses)   │
│   watchers: "(3)" title counters, web notifications, CSS sel. │
│   telegram: notify + /pause /resume /stop /status /shot       │
└───────────────┬───────────────────────────────────────────────┘
   analyzer.mode│
     bridge ────┴─► bridge/bridge.py ◄─► Claude Code (debug, now)
     anthropic ───► Claude API with your key (production, later)
     none ────────► watch & notify only
```

## Setup

1. **Load the extension:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
   pick the `extension/` folder.
2. **Start the bridge** (debug mode): `python3 bridge/bridge.py` (Python 3.8+, no packages needed).
3. Open the target website, click the extension icon → **Link this tab**.
4. ⚙ **Settings**: put the page URLs in *Feed* (one per line), set up Telegram (optional), save.
5. Press **Start**. Start opens no page and does no job on its own; while the screen is unchanged it
   only makes small humanized idle moves (mouse drift, a short scroll down and back). In Claude Code, tell Claude the job and ask it to *"run the debug
   loop"* (see `CLAUDE.md`). Claude looks at each screenshot and sends back actions. Its first `next`
   opens feed URL 1, each later `next` the following URL; the run ends after the last one.

## Humanized behaviour

- Mouse: curved Bézier paths with minimum-jerk easing, Fitts-law durations, small tremor,
  occasional overshoot and correction, click point drawn from a Gaussian inside the target box,
  realistic press/release timing.
- Typing: a speed "mood" (WPM range) per message, log-normal key intervals, longer pauses after
  spaces and punctuation, random hesitations, and neighbouring-key typos that get fixed.
- Rhythm: a think pause before every action, a reading pause before acting, random idle
  mouse wander, scrolling in short bursts, working-hours window, random breaks, and a limit on
  actions per hour.

## Low-end vs high-end PCs

`Settings → Performance profile` (auto-detected by default; 4 threads or ≤4 GB RAM → *low*):

| | low (e.g. i5-3xxx, 4 GB) | high |
|---|---|---|
| screenshot width | 1024 px, JPEG q55 | 1568 px, JPEG q80 |
| change-detect thumbnail | 24×24 | 48×48 |
| mouse events per move | ≤24 | ≤80 |
| minimum loop interval | 6 s | 2 s |

The AI step only runs when the screen changes, a page event arrives, or *Force analysis every*
has passed, so the machine stays idle most of the time. There is no bundler or framework and no
background polling, apart from a 2 s title/selector check inside the page.

## Input drivers

- **Debugger** (default): Chrome DevTools Protocol input. Events are *trusted*, the same as real
  hardware input. Chrome shows a "…started debugging this browser" bar while it runs. Closing that
  bar pauses the run, and Resume re-attaches. You can't use DevTools on the same tab at the same time.
- **DOM**: synthetic events, with no banner. Some sites ignore them (`isTrusted=false`). Useful for testing.

## Going to production (API key)

Settings → Analyzer → mode **Claude API**, paste the key, and pick the model (`claude-opus-5-5`
by default; `claude-haiku-5-5` is much cheaper for a high-frequency loop). The request uses
structured JSON output with the same schema the bridge uses, so the behaviour stays the same.
It also turns on Anthropic's server-side refusal fallback. The key is kept in
`chrome.storage.local` in this browser profile.

- **Job:** Settings → Feed & job → **Job** is what the model does on every page. It comes pre-filled
  with the LinkedIn connect job (`jobs/linkedin-connect.md`). Clear the box to restore the default.
  The job goes into the system prompt and is cached, so it costs little after the first turn.
- **First message:** the extension picks one saved first message at random for each page
  (`MESSAGE FOR THIS PAGE` in the prompt). The model only fills in the name.
- **Cost:** the popup shows a running estimate (≈$ spent). On Opus 5.5 at 1/2 screenshot size, one
  turn is roughly 1–2 cents. A profile takes about 6–8 turns: browse, Connect, Add a note, type,
  review, next.
- **Watching a run:** with **Mirror turns to the bridge** on (Analyzer section) and the bridge running,
  every API turn (screenshot, prompt, answer, tokens) is also saved to `bridge/data/mirror/`. See them
  with `python3 bridge/cli.py mirror 10`. The bridge never answers these, so it can't change a run.

## Telegram

Create a bot with @BotFather, send it any message, and read your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`. If you enable commands, the bot accepts
`/status /pause /resume /stop /shot`, but only from that chat id.

## Known limits (template stage)

- Web notifications are caught only after Start, when the hook is injected. Title counters and
  selectors work at any time.
- Only the top frame is driven. Content inside iframes needs coordinates (debugger driver) rather than selectors.
- If the MV3 service worker restarts (rare while running, because of keep-alive), the run
  stops and you press Start again.
- Check the target site's terms of service. Many sites forbid automated use.
