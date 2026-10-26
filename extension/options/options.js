import { DEFAULTS, loadSettings, saveSettings } from '../lib/settings.js';
import { detectHardware, resolveProfile } from '../lib/profiles.js';

// [path, label, type, extra]. type: text | number | textarea | check | select | password | time
const SECTIONS = [
  ['Job', [
    ['task.instructions', 'Job instructions for the analyzer', 'textarea', { wide: true, rows: 6, help: 'Sent with every screenshot. Be concrete: what to look for, what to reply, when to notify you.' }],
    ['task.forceAnalyzeEverySec', 'Force analysis every (sec)', 'number', { help: 'Even if the screen looks unchanged.' }],
    ['task.changeThreshold', 'Change threshold (0-255)', 'number', { help: 'Lower = more sensitive = more AI calls.' }],
    ['task.historyLength', 'History turns sent', 'number'],
  ]],
  ['Analyzer', [
    ['analyzer.mode', 'Mode', 'select', { options: [['bridge', 'Bridge – debug via Claude Code'], ['anthropic', 'Claude API (API key)'], ['none', 'None – watch & notify only']] }],
    ['analyzer.bridgeUrl', 'Bridge URL', 'text'],
    ['analyzer.bridgeTimeoutSec', 'Bridge answer timeout (sec)', 'number'],
    ['analyzer.apiKey', 'Anthropic API key', 'password', { help: 'Stored locally in this browser profile only.' }],
    ['analyzer.model', 'Model', 'text', { help: 'e.g. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5' }],
    ['analyzer.effort', 'Effort', 'select', { options: [['low', 'low'], ['medium', 'medium'], ['high', 'high']] }],
  ]],
  ['Input & performance', [
    ['input.driver', 'Input driver', 'select', { options: [['debugger', 'Debugger (trusted events, shows banner)'], ['dom', 'DOM events (no banner, less compatible)']] }],
    ['performance.profile', 'Performance profile', 'select', { options: [['auto', 'Auto-detect'], ['low', 'Low-end PC'], ['high', 'High-end PC']] }],
    ['input.showCursor', 'Show debug cursor dot', 'check'],
    ['debug.verbose', 'Verbose log', 'check'],
  ]],
  ['Human behaviour', [
    ['human.loopMinSec', 'Idle check min (sec)', 'number'],
    ['human.loopMaxSec', 'Idle check max (sec)', 'number'],
    ['human.thinkMinMs', 'Think before action min (ms)', 'number'],
    ['human.thinkMaxMs', 'Think before action max (ms)', 'number'],
    ['human.wpmMin', 'Typing speed min (WPM)', 'number'],
    ['human.wpmMax', 'Typing speed max (WPM)', 'number'],
    ['human.typoRate', 'Typo rate (0-0.2)', 'number', { step: 0.01 }],
    ['human.maxActionsPerHour', 'Max actions per hour', 'number'],
    ['human.idleMoveChance', 'Idle mouse wander chance', 'number', { step: 0.01 }],
    ['human.idleScrollChance', 'Idle scroll chance', 'number', { step: 0.01 }],
    ['human.workStart', 'Work hours start', 'time'],
    ['human.workEnd', 'Work hours end', 'time'],
    ['human.breaksEnabled', 'Take random breaks', 'check'],
    ['human.breakEveryMinMin', 'Break every min (min)', 'number'],
    ['human.breakEveryMaxMin', 'Break every max (min)', 'number'],
    ['human.breakLenMinMin', 'Break length min (min)', 'number'],
    ['human.breakLenMaxMin', 'Break length max (min)', 'number'],
  ]],
  ['Watchers', [
    ['watch.titleBadge', 'Detect "(3)" unread counters in title', 'check'],
    ['watch.notificationApi', 'Detect web notifications', 'check'],
    ['watch.selectors', 'CSS selectors of new-message markers', 'textarea', { wide: true, rows: 3, help: 'One per line. A new matching element triggers an event.' }],
  ]],
  ['Telegram', [
    ['telegram.enabled', 'Enabled', 'check'],
    ['telegram.botToken', 'Bot token', 'password', { help: 'From @BotFather.' }],
    ['telegram.chatId', 'Chat ID', 'text', { help: 'Message your bot, then open api.telegram.org/bot<token>/getUpdates.' }],
    ['telegram.notifyOnStartStop', 'Notify start/stop', 'check'],
    ['telegram.notifyOnEvents', 'Forward detected events', 'check'],
    ['telegram.sendScreenshotOnEvent', 'Attach screenshot to events', 'check'],
    ['telegram.commandsEnabled', 'Accept /pause /resume /stop /status /shot', 'check'],
  ]],
];

const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const set = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v;
};

const form = document.getElementById('form');
const msg = (t) => (document.getElementById('msg').textContent = t);

function build() {
  for (const [title, fields] of SECTIONS) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>${title}</h2><div class="grid"></div>`;
    const grid = card.querySelector('.grid');
    for (const [path, label, type, extra = {}] of fields) {
      const f = document.createElement('div');
      f.className = `field${extra.wide ? ' wide' : ''}${type === 'check' ? ' check' : ''}`;
      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = extra.rows || 3;
      } else if (type === 'select') {
        input = document.createElement('select');
        for (const [v, l] of extra.options) input.add(new Option(l, v));
      } else {
        input = document.createElement('input');
        input.type = type === 'check' ? 'checkbox' : type;
        if (extra.step) input.step = extra.step;
        if (type === 'number' && !extra.step) input.step = 'any';
      }
      input.dataset.path = path;
      input.dataset.kind = type;
      input.id = path;
      const lab = document.createElement('label');
      lab.htmlFor = path;
      lab.textContent = label;
      if (type === 'check') {
        lab.prepend(input);
        f.append(lab);
      } else f.append(lab, input);
      if (extra.help) {
        const h = document.createElement('div');
        h.className = 'help';
        h.textContent = extra.help;
        f.append(h);
      }
      grid.append(f);
    }
    form.append(card);
  }
}

function fill(s) {
  for (const el of form.querySelectorAll('[data-path]')) {
    const v = get(s, el.dataset.path);
    if (el.dataset.kind === 'check') el.checked = !!v;
    else el.value = v ?? '';
  }
}

function collect(base) {
  const s = structuredClone(base);
  for (const el of form.querySelectorAll('[data-path]')) {
    const k = el.dataset.kind;
    set(s, el.dataset.path, k === 'check' ? el.checked : k === 'number' ? Number(el.value) : el.value);
  }
  return s;
}

let current;
build();
current = await loadSettings();
fill(current);
const hw = detectHardware();
document.getElementById('hw').textContent = `Detected: ${hw.cores} threads, ~${hw.memoryGb} GB RAM → auto profile "${resolveProfile('auto').name}". Changes apply on next Start.`;

document.getElementById('save').onclick = async () => {
  current = collect(current);
  await saveSettings(current);
  msg('Saved ✓ (takes effect on next Start)');
};
document.getElementById('reset').onclick = () => {
  if (!confirm('Reset all settings to defaults?')) return;
  fill(DEFAULTS);
  msg('Defaults loaded – press Save to keep them');
};
document.getElementById('testBridge').onclick = async () => {
  const url = form.querySelector('[data-path="analyzer.bridgeUrl"]').value;
  const r = await chrome.runtime.sendMessage({ type: 'testBridge', url });
  msg(r.ok ? `Bridge OK · pending: ${r.health.pending?.length ?? 0}` : `Bridge error: ${r.error}`);
};
document.getElementById('testTelegram').onclick = async () => {
  await saveSettings(collect(current));
  const r = await chrome.runtime.sendMessage({ type: 'testTelegram' });
  msg(r.ok ? 'Telegram message sent ✓' : `Telegram error: ${r.error}`);
};
