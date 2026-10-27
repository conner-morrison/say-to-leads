import { DEFAULTS, loadSettings, saveSettings } from '../lib/settings.js';
import { detectHardware, resolveProfile } from '../lib/profiles.js';

// [path, label, type, extra]. type: text | number | textarea | check | select | password | time | list
const SECTIONS = [
  ['Feed', [
    ['task.feed', 'Page URLs, one per line', 'textarea', { wide: true, rows: 8, help: 'Opened in the linked tab in this order, one at a time, when the analyzer asks for the next page (Start itself opens nothing). The run ends after the last URL. Lines starting with # are skipped.' }],
    ['task.forceAnalyzeEverySec', 'Force analysis every (sec)', 'number', { help: 'Even if the screen looks unchanged.' }],
    ['task.changeThreshold', 'Change threshold (0-255)', 'number', { help: 'Lower = more sensitive = more AI calls.' }],
    ['task.historyLength', 'History turns sent', 'number'],
  ]],
  ['First messages', [
    ['messages.first', 'Saved first messages', 'list', { wide: true, addLabel: '+ Add message', help: 'Openers the analyzer can send when the job asks for a first message. Empty boxes are dropped on save.' }],
    ['messages.sendMode', 'Send mode', 'select', {
      options: [['review', 'Review – type it, then pause for me to check and send'], ['auto', 'Full auto – click Send automatically']],
      help: 'In Review mode you get a Telegram note; click Send yourself, then press Resume.',
    }],
  ]],
  ['Inbox monitor', [
    ['monitor.inboxEveryMin', 'Check Messaging panel every (min)', 'number', {
      help: 'The AI reads the Messaging panel on the right: unread (blue bold) items → new message; a different person on top than last time → they accepted your invitation. You get a Telegram note. 0 = off. Not checked while paused.',
    }],
  ]],
  ['Analyzer', [
    ['analyzer.mode', 'Mode', 'select', { options: [['bridge', 'Bridge – debug via Claude Code'], ['anthropic', 'Claude API (API key)'], ['none', 'None – watch & notify only']] }],
    ['analyzer.bridgeUrl', 'Bridge URL', 'text'],
    ['analyzer.bridgeTimeoutSec', 'Bridge answer timeout (sec)', 'number'],
    ['analyzer.apiKey', 'Anthropic API key', 'password', { help: 'Stored locally in this browser profile only.' }],
    ['analyzer.model', 'Model', 'select', {
      options: [
        ['claude-opus-5-5', 'Claude Opus 5.5 – recommended ($4 / $20 per 1M tokens)'],
        ['claude-sonnet-5-5', 'Claude Sonnet 5.5 – faster, cheaper ($2 / $10)'],
        ['claude-haiku-5-5', 'Claude Haiku 5.5 – cheapest for a busy loop ($0.10 / $0.50)'],
        ['claude-fable-5-1', 'Claude Fable 5.1 – most capable, slowest ($10 / $50)'],
      ],
      help: 'Used only in Claude API mode. Prices are input / output per 1M tokens.',
    }],
    ['analyzer.effort', 'Effort', 'select', { options: [['low', 'low'], ['medium', 'medium'], ['high', 'high']] }],
    ['analyzer.imageScale', 'Screenshot size for AI', 'select', {
      options: [['1', 'Full'], ['0.5', '1/2 (~1/4 of image cost)'], ['0.333', '1/3 (~1/9 of image cost)']],
      help: 'Smaller is cheaper, but small text gets hard to read. Raise it if clicks miss.',
    }],
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
      } else if (type === 'list') {
        input = document.createElement('div');
        input.className = 'list';
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
      if (type === 'list') {
        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = extra.addLabel || '+ Add';
        add.onclick = () => addListItem(input, '').querySelector('textarea').focus();
        f.append(add);
      }
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

// One numbered textarea + Remove button inside a "list" field.
function addListItem(list, text) {
  const row = document.createElement('div');
  row.className = 'list-item';
  const n = document.createElement('span');
  n.className = 'list-num';
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = text;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'Remove';
  del.onclick = () => {
    row.remove();
    renumber(list);
  };
  row.append(n, ta, del);
  list.append(row);
  renumber(list);
  return row;
}

function renumber(list) {
  list.querySelectorAll('.list-num').forEach((n, i) => (n.textContent = `${i + 1}.`));
}

function fill(s) {
  for (const el of form.querySelectorAll('[data-path]')) {
    const v = get(s, el.dataset.path);
    if (el.dataset.kind === 'list') {
      el.textContent = '';
      for (const t of Array.isArray(v) ? v : []) addListItem(el, t);
    } else if (el.dataset.kind === 'check') el.checked = !!v;
    else {
      // Keep a saved value that is no longer in the list instead of showing a blank select.
      if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) el.add(new Option(v, v));
      el.value = v ?? '';
    }
  }
}

function collect(base) {
  const s = structuredClone(base);
  for (const el of form.querySelectorAll('[data-path]')) {
    const k = el.dataset.kind;
    if (k === 'list') {
      set(s, el.dataset.path, [...el.querySelectorAll('textarea')].map((t) => t.value.trim()).filter(Boolean));
      continue;
    }
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
