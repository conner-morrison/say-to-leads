// Settings schema + persistence. Everything the user can tune lives here.

export const DEFAULTS = {
  task: {
    // What the analyzer (Claude Code in debug mode, or the API later) should do on this site.
    instructions:
      'Describe the job here. Example: "Watch the inbox. When a new lead message appears, open it, reply with a short friendly greeting, then notify me on Telegram."',
    // Ask the analyzer at least this often even if the screen looks unchanged.
    forceAnalyzeEverySec: 180,
    // Mean pixel difference (0-255) on the tiny thumbnail that counts as "screen changed".
    changeThreshold: 5,
    // How many recent analyzer summaries to send back as short-term memory.
    historyLength: 6,
  },
  analyzer: {
    mode: 'bridge', // 'bridge' (debug, Claude Code) | 'anthropic' (API key) | 'none' (watch-only)
    bridgeUrl: 'http://127.0.0.1:8765',
    bridgeTimeoutSec: 900,
    apiKey: '',
    model: 'claude-opus-5-5',
    effort: 'low', // low | medium | high – low keeps latency/cost down for a loop
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
  return deepMerge(structuredClone(DEFAULTS), settings || {});
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
