// The contract between the extension and any analyzer (Claude Code via bridge, or the API).
// Keep bridge/cli.py ACTION_TYPES and CLAUDE.md in sync with this file.

export const ACTION_TYPES = ['click', 'double_click', 'hover', 'type', 'key', 'scroll', 'browse', 'connect', 'add_note', 'note', 'send_invite', 'wait', 'notify', 'next', 'pause', 'stop'];

// Error alarms the analyzer can raise with notify; the extension sends them and stops the run.
export const ALERT_KINDS = ['weekly_limit', 'linkedin_error'];

// Per-page results reported with "next", counted for the weekly summary.
export const OUTCOMES = ['sent', 'pending', 'error'];

// The Claude API compiles this schema into a grammar, and every optional field roughly doubles it:
// one action object with all fields optional was rejected as "Schema is too complex". So each action
// type is its own small variant with every field required. The API schema is stricter than the
// contract: x/y, selector, browse "sec" and a "type" without a target are bridge-only (sanitizeResult
// and cli.py still accept them).
const BOX = { type: 'array', items: { type: 'number' }, description: '[x1,y1,x2,y2] normalized 0..1 – the whole target' };
const action = (types, props = {}) => ({
  type: 'object',
  additionalProperties: false,
  required: ['type', ...Object.keys(props)],
  properties: { type: { type: 'string', enum: types }, ...props },
});
const ACTION_VARIANTS = [
  action(['click', 'double_click', 'hover'], { box: BOX }),
  action(['type'], { box: BOX, text: { type: 'string' }, clear: { type: 'boolean', description: 'clear the field first' } }),
  action(['key'], { key: { type: 'string', description: 'e.g. Enter, Escape, Tab, Ctrl+A' } }),
  action(['scroll'], { dy: { type: 'number', description: 'pixels, positive = down' } }),
  action(['wait'], { ms: { type: 'number' } }),
  action(['browse', 'connect', 'add_note', 'send_invite']),
  action(['note'], { text: { type: 'string', description: 'the whole note, with \\n for line breaks' } }),
  action(['notify'], {
    text: { type: 'string' },
    photo: { type: 'boolean', description: 'attach the screenshot' },
    alert: { enum: [...ALERT_KINDS, null], description: 'an error alarm – the run stops after it; null = a plain note' },
  }),
  action(['next'], { outcome: { type: 'string', enum: OUTCOMES, description: 'what happened on the page that is done' } }),
  action(['pause', 'stop'], { reason: { type: 'string' } }),
];

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'actions', 'next_check_sec'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what is on screen and what you decided.' },
    actions: { type: 'array', items: { anyOf: ACTION_VARIANTS } },
    next_check_sec: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    inbox: {
      type: 'object',
      additionalProperties: false,
      required: ['top', 'unread', 'accepted'],
      description: 'Only when an INBOX CHECK is due and the Messaging panel is visible.',
      properties: {
        top: { type: 'string', description: 'Name of the first conversation in the Messaging list' },
        unread: { type: 'array', items: { type: 'string' }, description: 'Names of unread (blue bold) conversations' },
        accepted: { type: 'array', items: { type: 'string' }, description: 'People who newly appeared above the previous top without being unread' },
      },
    },
  },
};

export const SYSTEM_PROMPT = `You operate one browser tab on behalf of a human, through screenshots.
You may work through a feed: a list of page URLs opened one at a time in that tab, each only when
you send "next". Each turn you get a screenshot of the visible viewport, your position in the feed, recent page
events (new notifications / unread counters) and a short history of your previous turns on this page.

Reply with JSON only, matching the schema:
- summary: what you see and what you decided.
- actions: a short list (0-5) executed in order with human-like timing. Coordinates are normalized
  to the screenshot: 0..1 from the top-left. Targets are a "box" [x1,y1,x2,y2] around the whole button/field.
  click/double_click/hover need a box. "type" clicks its box (the field), then types text (set
  clear=true to replace existing text). "key" presses a key or combo (Enter, Escape, Ctrl+A).
  "scroll" uses dy pixels. "browse" reads the whole page like a person (random scrolls to any depth,
  pauses, then back to the top) without screenshots. "connect" (LinkedIn profiles) finds the profile header's
  Connect button itself – directly or in the More (…) menu – and clicks it; RESULT OF YOUR LAST ACTIONS says
  what it did or why it found none. In LinkedIn's invitation modal, "add_note" clicks Add a note (never
  "Send without a note"), "note" types text into the note box and reports the character count, and
  "send_invite" clicks the modal's Send. "wait" waits ms. "notify" messages the human on Telegram (photo=true to
  attach the screenshot; alert="weekly_limit" or "linkedin_error" marks an error alarm, and the run
  stops right after it, so do any cleanup such as Escape before it). "next" means the job on this page is done (outcome = what happened there, when the job
  asks for it): the next feed URL is opened (after
  the last one the run ends) and actions after it are skipped. "pause" pauses the run for the human.
  "stop" ends the run.
- next_check_sec: when to look again (null = default pacing).
- inbox: only when the prompt says an INBOX CHECK is due (see there); otherwise leave it out.

Rules: if FEED says "not opened yet", the job has not started: answer only "next" (or nothing).
Act only on what you can see. After a meaningful action, verify on the next screenshot
instead of chaining many blind steps. If unsure or something looks wrong (login wall, captcha,
error, unexpected page), use notify with alert "linkedin_error" (photo) rather than guessing. Empty actions is fine.`;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v)));

export function sanitizeResult(r) {
  if (!r || typeof r !== 'object') throw new Error('analyzer returned no object');
  const actions = Array.isArray(r.actions) ? r.actions : [];
  const names = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const inbox = r.inbox && typeof r.inbox === 'object' && typeof r.inbox.top === 'string'
    ? { top: r.inbox.top.trim(), unread: names(r.inbox.unread), accepted: names(r.inbox.accepted) }
    : null;
  return {
    inbox,
    summary: String(r.summary || ''),
    next_check_sec: typeof r.next_check_sec === 'number' && r.next_check_sec >= 0 ? r.next_check_sec : null,
    actions: actions
      .filter((a) => a && ACTION_TYPES.includes(a.type))
      .slice(0, 10)
      .map((a) => {
        const out = { ...a };
        if (out.x != null) out.x = clamp01(out.x);
        if (out.y != null) out.y = clamp01(out.y);
        if (Array.isArray(out.box) && out.box.length === 4) out.box = out.box.map(clamp01);
        else delete out.box;
        return out;
      }),
  };
}
