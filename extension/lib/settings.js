// Settings schema + persistence. Everything the user can tune lives here.

import { DEFAULT_JOB } from './job-default.js';

export const DEFAULTS = {
  task: {
    // Pages to work through, one URL per line, opened in the linked tab in order. Start opens
    // nothing; each "next" action from the analyzer opens the following URL.
    feed: '',
    // What the analyzer should do on each page. Sent with every request (cached as part of the
    // system prompt in Claude API mode). In bridge mode Claude Code also follows jobs/*.md.
    job: DEFAULT_JOB,
    // Ask the analyzer at least this often even if the screen looks unchanged.
    forceAnalyzeEverySec: 180,
    // Mean pixel difference (0-255) on the tiny thumbnail that counts as "screen changed".
    changeThreshold: 5,
    // How many recent analyzer summaries to send back as short-term memory.
    historyLength: 6,
  },
  messages: {
    // Saved first messages (openers). Sent to the analyzer with every request.
    first: [],
    // 'review': type the message, then pause so the human checks it and sends it.
    // 'auto': the analyzer clicks Send itself.
    sendMode: 'review',
  },
  monitor: {
    // Every N minutes the analyzer reads the Messaging panel: unread (blue bold) conversations are
    // new messages, and a new name on top since the last check is someone who accepted. 0 = off.
    inboxEveryMin: 60,
  },
  analyzer: {
    mode: 'bridge', // 'bridge' (debug, Claude Code) | 'anthropic' (API key) | 'none' (watch-only)
    bridgeUrl: 'http://127.0.0.1:8765',
    bridgeTimeoutSec: 900,
    apiKey: '',
    model: 'claude-opus-5-5',
    effort: 'low', // low | medium | high – low keeps latency/cost down for a loop
    imageScale: 0.333, // screenshot size sent to the analyzer: 1 | 0.5 | 0.333 (≈1/9 of the image tokens)
    mirrorToBridge: true, // Claude API mode: also POST each turn to the bridge's /mirror so a run can be watched
  },
  input: {
    driver: 'debugger', // 'debugger' = trusted CDP input (recommended) | 'dom' = synthetic events
    showCursor: true, // draw a small dot where the bot "mouse" is (debug aid)
  },
  performance: {
    profile: 'auto', // auto | low | high
  },
  human: {
    loopMinSec: 4,
    loopMaxSec: 12,
    thinkMinMs: 500,
    thinkMaxMs: 1800,
    wpmMin: 32,
    wpmMax: 58,
    typoRate: 0.03,
    idleMoveChance: 0.15, // wander the mouse a bit while idle
    idleScrollChance: 0.05,
    maxActionsPerHour: 150,
    workStart: '00:00', // local time window when work is allowed
    workEnd: '23:59',
    breaksEnabled: true,
    breakEveryMinMin: 35,
    breakEveryMaxMin: 75,
    breakLenMinMin: 3,
    breakLenMaxMin: 12,
  },
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    notifyOnStartStop: true,
    notifyOnEvents: true, // forward detected notifications / new messages
    sendScreenshotOnEvent: false,
    commandsEnabled: false, // accept /pause /resume /stop /status /shot from the chat
  },
  watch: {
    titleBadge: true, // "(3) Inbox" style unread counters in the tab title
    notificationApi: true, // page calls to new Notification(...)
    selectors: '', // newline-separated CSS selectors of badges/new-message markers
  },
  debug: {
    verbose: true,
  },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (isObj(base[k]) && isObj(over[k])) deepMerge(base[k], over[k]);
    else if (over[k] !== undefined) base[k] = over[k];
  }
  return base;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = deepMerge(structuredClone(DEFAULTS), settings || {});
  if (!String(s.task.job || '').trim()) s.task.job = DEFAULT_JOB; // an emptied box means "use the default"
  return s;
}

export async function saveSettings(settings) {
  // An unedited job is stored empty, so improvements to the built-in default reach existing installs.
  if (String(settings.task?.job || '').trim() === DEFAULT_JOB.trim()) settings = { ...settings, task: { ...settings.task, job: '' } };
  await chrome.storage.local.set({ settings });
}
