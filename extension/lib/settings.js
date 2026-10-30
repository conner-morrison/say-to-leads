// Settings schema + persistence. Everything the user can tune lives here.

import { DEFAULT_JOB } from './job-default.js';
import { ENV_KEYS, loadEnv } from './env.js';

export const DEFAULTS = {
  task: {
    // Pages to work through, one URL per line, opened in the linked tab in order. Start opens
    // nothing; each "next" action from the analyzer opens the following URL.
    feed: '',
    // Where the URLs come from: 'server' = the relay server sends them (Settings → Registration),
    // queued and worked through in arrival order; 'urls' = the list in `feed` below.
    source: 'server',
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
    imageScale: 0.5, // screenshot size sent to the analyzer: 1 | 0.5 | 0.333 – 1/3 made LinkedIn's toast, counter and names unreadable
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
    // Which alarms to send. Weekly limit, LinkedIn and extension errors also stop the run (always),
    // so a human checks and presses Start again.
    alerts: {
      newMessage: true, // unread conversations in the Messaging panel
      accepted: true, // someone accepted an invitation (new name on top of the Messaging panel)
      weeklyLimit: true, // LinkedIn's weekly invitation limit was hit
      linkedinError: true, // anything else wrong on LinkedIn: Premium gone, login wall, captcha, error page
      extensionError: true, // the extension itself failed (crash, API/bridge error, failed action, debugger)
    },
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

const getPath = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((x, k) => x[k], o)[last] = v;
}

// DEFAULTS with the values from extension/.env on top (see lib/env.js).
export async function baseSettings() {
  const base = structuredClone(DEFAULTS);
  const env = await loadEnv();
  for (const [key, path] of Object.entries(ENV_KEYS)) if (env[key]) setPath(base, path, env[key]);
  return base;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const base = await baseSettings();
  const s = deepMerge(structuredClone(base), settings || {});
  if (!String(s.task.job || '').trim()) s.task.job = DEFAULT_JOB; // an emptied box means "use the default"
  // An empty field means "use .env / the default", so a key in .env fills a box left blank in Settings.
  for (const path of Object.values(ENV_KEYS)) if (getPath(s, path) === '') setPath(s, path, getPath(base, path));
  return s;
}

export async function saveSettings(settings) {
  // An unedited job is stored empty, so improvements to the built-in default reach existing installs.
  if (String(settings.task?.job || '').trim() === DEFAULT_JOB.trim()) settings = { ...settings, task: { ...settings.task, job: '' } };
  // Same for values that came from .env: stored empty, so editing .env (and reloading) takes effect.
  settings = structuredClone(settings);
  const base = await baseSettings();
  for (const path of Object.values(ENV_KEYS)) if (getPath(settings, path) === getPath(base, path)) setPath(settings, path, '');
  await chrome.storage.local.set({ settings });
}
