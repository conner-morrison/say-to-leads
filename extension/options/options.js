import { baseSettings, loadSettings, saveSettings } from '../lib/settings.js';
import { loadEnv } from '../lib/env.js';
import { checkKey, keyStatus } from '../lib/apikey.js';
import { detectHardware, resolveProfile } from '../lib/profiles.js';
import { DEFAULT_RELAY_URL } from '../lib/relay.js';
import { toMin, totalMin } from '../lib/schedule.js';

// [path, label, type, extra]. type: text | number | textarea | check | select | password | time | list
const SECTIONS = [
  ['Schedule', [
    ['schedule.intervals', 'Day schedule', 'schedule'],
    ['schedule.enabled', 'Work by the day schedule', 'check', { help: 'Off: the work hours under Human behaviour apply instead and nothing starts by itself.' }],
    ['schedule.hoursMin', 'Work per day min (h)', 'number', { step: 0.25 }],
    ['schedule.hoursMax', 'Work per day max (h)', 'number', { step: 0.25 }],
    ['schedule.partsMin', 'Intervals min', 'number', { step: 1 }],
    ['schedule.partsMax', 'Intervals max', 'number', { step: 1 }],
    ['schedule.gapMinMin', 'Gap between intervals min (min)', 'number', { step: 1 }],
    ['schedule.gapMaxMin', 'Gap between intervals max (min)', 'number', { step: 1 }],
    ['schedule.dayStart', 'Earliest start', 'time'],
    ['schedule.dayEnd', 'Aim to end by', 'time'],
  ], { reset: 'schedule' }],
  ['Feed & job', [
    ['task.source', 'URLs come from', 'select', {
      wide: true,
      options: [['server', 'Server – registered extension; leads (URL + name) come from the server'], ['urls', 'URL list – the page URLs entered below']],
      help: 'Server: leads are fetched 10 at a time into a queue and handled oldest first; when the queue is empty the next ones are fetched, and with none left it watches for the server\'s new-lead trigger. URL list: press Start to work through the list below.',
    }],
    ['task.job', 'Job (what to do on each page)', 'textarea', { wide: true, rows: 14, help: 'Instructions the AI follows on every page. Clear the box and save to restore the default LinkedIn connect job.' }],
    ['task.feed', 'Page URLs, one per line', 'textarea', { wide: true, rows: 8, help: 'Used when "URLs come from" is URL list. Opened in the linked tab in this order, one at a time, when the analyzer asks for the next page (Start itself opens nothing). The run ends after the last URL. Lines starting with # are skipped.' }],
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
    ['analyzer.apiKey', 'Claude API key', 'apikey'],
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
    ['analyzer.mirrorToBridge', 'Mirror turns to the bridge', 'check', { help: 'Claude API mode: also send each turn (screenshot + answer) to the bridge so Claude Code can watch the run. Harmless if the bridge is off.' }],
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
    ['human.workStart', 'Work hours start (schedule off)', 'time'],
    ['human.workEnd', 'Work hours end (schedule off)', 'time'],
    ['human.breaksEnabled', 'Take random breaks', 'check'],
    ['human.breakEveryMinMin', 'Break every min (min)', 'number'],
    ['human.breakEveryMaxMin', 'Break every max (min)', 'number'],
    ['human.breakLenMinMin', 'Break length min (min)', 'number'],
    ['human.breakLenMaxMin', 'Break length max (min)', 'number'],
  ], { reset: 'human' }],
  ['Watchers', [
    ['watch.titleBadge', 'Detect "(3)" unread counters in title', 'check'],
    ['watch.notificationApi', 'Detect web notifications', 'check'],
    ['watch.selectors', 'CSS selectors of new-message markers', 'textarea', { wide: true, rows: 3, help: 'One per line. A new matching element triggers an event.' }],
  ]],
  ['Telegram', [
    ['telegram.enabled', 'Enabled', 'check'],
    ['telegram.botToken', 'Bot token', 'password', { help: 'From @BotFather.' }],
    ['telegram.chatId', 'Chat ID', 'text', { help: 'Message your bot, then open api.telegram.org/bot<token>/getUpdates.' }],
    ['telegram.alerts.newMessage', 'New message', 'check', { help: 'Unread (blue bold) conversations in the Messaging panel.' }],
    ['telegram.alerts.accepted', 'New acceptance', 'check', { help: 'Someone accepted your invitation.' }],
    ['telegram.alerts.weeklyLimit', 'Weekly limit', 'check', { help: 'Invitation not sent: weekly limit reached. The run stops.' }],
    ['telegram.alerts.linkedinError', 'LinkedIn error', 'check', { help: 'Premium gone, login wall, captcha, error page… The run stops.' }],
    ['telegram.alerts.extensionError', 'Extension error', 'check', { help: 'Any error of the extension itself (crash, API, failed action). The run stops.' }],
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
  for (const [title, fields, opts = {}] of SECTIONS) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>${title}</h2><div class="grid"></div>`;
    if (opts.reset) {
      // Loads the defaults for this section's fields only; Save keeps them.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Default';
      btn.onclick = async () => {
        fill(await baseSettings(), `${opts.reset}.`);
        msg(`${title} defaults loaded – press Save to keep them`);
      };
      const h2 = card.querySelector('h2');
      h2.classList.add('with-btn');
      h2.append(btn);
    }
    const grid = card.querySelector('.grid');
    for (const [path, label, type, extra = {}] of fields) {
      if (type === 'apikey') {
        grid.append(keyField(label));
        continue;
      }
      if (type === 'schedule') {
        grid.append(scheduleField(label));
        continue;
      }
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

// ---------- Claude API key ----------
// Not a data-path field: the key is saved on its own (Save key checks it first) and is never shown back,
// so the main Save cannot write an old key over a newer one.

function keyField(label) {
  const f = document.createElement('div');
  f.className = 'field wide';
  f.innerHTML = `<label for="apiKey"></label>
    <div class="key-row">
      <input id="apiKey" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />
      <button id="saveKey" type="button" class="primary">Save key</button>
      <button id="removeKey" type="button" class="danger">Remove</button>
    </div>
    <div id="keyStatus" class="key-status" role="status">Checking the saved key…</div>
    <div id="keyMsg" class="help" aria-live="polite"></div>
    <div class="help">Stored locally in this browser profile only. Save key checks it with Anthropic (no tokens used) and saves it right away.</div>`;
  f.querySelector('label').textContent = label;
  return f;
}

const savedKey = async () => String((await loadSettings()).analyzer.apiKey || '').trim();
const formMode = () => form.querySelector('[data-path="analyzer.mode"]').value;

async function renderKey() {
  const st = await keyStatus(await savedKey(), formMode(), env, 'above');
  const el = document.getElementById('keyStatus');
  el.textContent = st.text;
  el.className = `key-status ${st.cls}`;
  // Remove only clears a key saved here; a key from .env stays (it is the fallback).
  const { settings: stored } = await chrome.storage.local.get('settings');
  document.getElementById('removeKey').disabled = !stored?.analyzer?.apiKey;
}

function keyMsg(text, cls = '') {
  const el = document.getElementById('keyMsg');
  el.textContent = text;
  el.className = `help ${cls}`;
}

async function storeKey(key) {
  const s = await loadSettings();
  s.analyzer.apiKey = key;
  await saveSettings(s);
  current.analyzer.apiKey = (await loadSettings()).analyzer.apiKey;
}

function wireKey() {
  const input = document.getElementById('apiKey');
  const btn = document.getElementById('saveKey');
  btn.onclick = async () => {
    const key = input.value.trim();
    if (!key) return keyMsg('Paste the key first.', 'bad');
    if (!/^sk-ant-/.test(key)) return keyMsg('That does not look like a Claude API key (it starts with sk-ant-).', 'bad');
    btn.disabled = true;
    try {
      keyMsg('Checking the key…');
      const c = await checkKey(key);
      if (!c.ok) {
        await renderKey();
        return keyMsg(`Not saved: ${c.error}.`, 'bad');
      }
      await storeKey(key);
      input.value = '';
      await renderKey();
      keyMsg(`Saved – ${c.note}. A running run uses it from its next step.`, 'good');
    } finally {
      btn.disabled = false;
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btn.click();
    }
  };
  document.getElementById('removeKey').onclick = async () => {
    if (!confirm('Remove the saved Claude API key?')) return;
    await storeKey('');
    await renderKey();
    keyMsg(env.ANTHROPIC_API_KEY ? 'Removed – the key from extension/.env is used now.' : 'Removed.');
  };
  form.querySelector('[data-path="analyzer.mode"]').addEventListener('change', renderKey);
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.settings || ch.apiKeyCheck) renderKey();
  });
}

// ---------- day schedule ----------
// The intervals are not a data-path field: they are applied on their own (Schedule / Save schedule), because
// a change may need a question first (pause the run? start now?). The background decides; see reschedule().

let schedDirty = false;
let schedView = { day: 'today', intervals: [], skipped: [] }; // what the list shows

function scheduleField(label) {
  const f = document.createElement('div');
  f.className = 'field wide';
  f.innerHTML = `<label></label>
    <div id="schedStatus" class="key-status muted" role="status">Loading…</div>
    <div id="schedList" class="sched-list"></div>
    <div class="reg-row">
      <button id="schedNew" type="button" class="primary">Schedule</button>
      <button id="schedAdd" type="button">+ Add interval</button>
      <button id="schedSave" type="button" disabled>Save schedule</button>
      <button id="schedUndo" type="button" disabled>Undo edits</button>
    </div>
    <div id="schedMsg" class="help" aria-live="polite"></div>
    <div class="help">Made at random when the extension wakes up on a new day (5–6 h in 2–5 intervals, set below). Schedule makes a new random one now; or edit the times and press Save schedule. When today's work is over, a new schedule is for tomorrow. Between intervals the run waits as a break; at each interval it starts or resumes by itself with the latest Settings.</div>
    <dialog id="schedAsk"><p id="schedAskText"></p><div class="reg-row"><button id="schedYes" type="button" class="primary"></button><button id="schedNo" type="button"></button></div></dialog>`;
  f.querySelector('label').textContent = label;
  return f;
}

const fmtLen = (m) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`;
const hhmm = (m) => {
  m = Math.max(0, Math.min(m, 1439));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const ivLine = (ivs) => ivs.map((iv) => `${iv.start}–${iv.end}`).join(', ');
const HOLD_TEXT = {
  stop: 'stopped by you (until Start or tomorrow)',
  error: 'stopped by an error alarm (until Start)',
  done: 'the URL list is done (until Start)',
};

function schedMsg(text, cls = '') {
  const el = document.getElementById('schedMsg');
  el.textContent = text;
  el.className = `help ${cls}`;
}

// A yes/no dialog; Escape counts as no.
function ask(text, yes, no) {
  const d = document.getElementById('schedAsk');
  document.getElementById('schedAskText').textContent = text;
  document.getElementById('schedYes').textContent = yes;
  document.getElementById('schedNo').textContent = no;
  return new Promise((resolve) => {
    const done = (v) => () => {
      d.close();
      resolve(v);
    };
    document.getElementById('schedYes').onclick = done(true);
    document.getElementById('schedNo').onclick = done(false);
    d.oncancel = done(false);
    d.showModal();
  });
}

async function loadSched() {
  const r = await chrome.runtime.sendMessage({ type: 'schedule' });
  if (!r?.ok) return schedMsg(r?.error || 'The background did not answer.', 'bad');
  const sc = r.schedule;
  const today = sc.today;
  let text;
  let cls = 'muted';
  if (!sc.enabled) text = 'The day schedule is off – the work hours under Human behaviour apply.';
  else if (!today) text = 'No schedule yet – it is made when the extension wakes up.';
  else if (sc.over) {
    text = `Today's work is over (${ivLine(today.intervals)}). ${sc.next ? `Tomorrow: ${ivLine(sc.next.intervals)} (set by you).` : 'Tomorrow gets a random schedule when the extension wakes up.'} A new schedule now is for tomorrow.`;
  } else {
    const now = sc.slot >= 0 ? `working now, till ${today.intervals[sc.slot].end}` : 'between intervals';
    text = `Today (${today.source === 'manual' ? 'set by you' : 'random'}): ${today.intervals.length} intervals, ${fmtLen(totalMin(today.intervals))} – ${now}.`;
    cls = sc.slot >= 0 ? 'good' : 'warn';
  }
  if (sc.enabled && sc.hold) {
    text += ` Not starting by itself: ${HOLD_TEXT[sc.hold]}.`;
    cls = 'warn';
  }
  const st = document.getElementById('schedStatus');
  st.textContent = text;
  st.className = `key-status ${cls}`;
  if (schedDirty) return; // keep the human's edits
  schedView = sc.over
    ? { day: 'tomorrow', intervals: structuredClone(sc.next?.intervals || []), skipped: [] }
    : { day: 'today', intervals: structuredClone(today?.intervals || []), skipped: today?.skipped || [] };
  renderSchedList();
}

// The intervals as editable time boxes.
function renderSchedList() {
  const list = document.getElementById('schedList');
  list.textContent = '';
  const head = document.createElement('div');
  head.className = 'help';
  head.textContent = schedView.day === 'tomorrow' ? "Tomorrow's intervals" : "Today's intervals";
  list.append(head);
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  schedView.intervals.forEach((iv, i) => {
    const row = document.createElement('div');
    row.className = 'sched-row';
    row.innerHTML = `<span class="list-num">${i + 1}.</span><input type="time" /> – <input type="time" /><span class="sched-len help"></span><button type="button" class="danger">Remove</button>`;
    const [s, e] = row.querySelectorAll('input');
    s.value = iv.start;
    e.value = iv.end;
    const len = row.querySelector('.sched-len');
    const showLen = () => {
      const m = toMin(e.value) - toMin(s.value);
      const tag = schedView.skipped.includes(i) ? ' · skipped' : schedView.day === 'today' && toMin(e.value) <= now ? ' · done' : '';
      len.textContent = `${m > 0 ? fmtLen(m) : '–'}${tag}`;
    };
    showLen();
    for (const el of [s, e]) {
      el.oninput = () => {
        schedView.intervals[i] = { start: s.value, end: e.value };
        showLen();
        showTotal();
        dirty();
      };
    }
    row.querySelector('button').onclick = () => {
      schedView.intervals.splice(i, 1);
      schedView.skipped = [];
      dirty();
      renderSchedList();
    };
    list.append(row);
  });
  const tot = document.createElement('div');
  tot.id = 'schedTotal';
  tot.className = 'help';
  list.append(tot);
  showTotal();
}

function showTotal() {
  const m = schedView.intervals.reduce((a, iv) => a + Math.max(0, toMin(iv.end) - toMin(iv.start)), 0);
  document.getElementById('schedTotal').textContent = schedView.intervals.length ? `Total ${fmtLen(m)}` : 'No intervals.';
}

function dirty(on = true) {
  schedDirty = on;
  document.getElementById('schedSave').disabled = !on;
  document.getElementById('schedUndo').disabled = !on;
  if (on) schedMsg('Edited – press Save schedule to use it.');
}

// Sends the new intervals; answers the background's questions with dialogs and sends them again.
async function applySchedule(intervals) {
  const answer = {};
  for (;;) {
    const r = await chrome.runtime.sendMessage({ type: 'reschedule', intervals, answer });
    if (!r?.ok) return schedMsg(`Not saved: ${r?.error || 'no answer'}`, 'bad');
    if (r.ask === 'pause') {
      answer.pause = await ask('The extension is working in an interval right now. Pause it to switch to the new schedule? It resumes with the latest Settings.', 'Pause and switch', 'Cancel');
      continue;
    }
    if (r.ask === 'start') {
      answer.start = await ask(`Now is inside the new interval ${r.interval.start}–${r.interval.end}. Start working now?`, 'Start now', 'No – break until the next interval');
      continue;
    }
    dirty(false);
    if (r.saved === false) schedMsg('Not changed – the run goes on with the old schedule.');
    else if (r.saved === 'tomorrow') schedMsg("Today's work is over, so this is tomorrow's schedule ✓", 'good');
    else if (r.started) schedMsg('New schedule saved – working now ✓', 'good');
    else if (answer.start === false) schedMsg('New schedule saved – this interval is skipped, work starts at the next one ✓', 'good');
    else schedMsg('New schedule saved ✓', 'good');
    return loadSched();
  }
}

function wireSched() {
  document.getElementById('schedNew').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'scheduleGenerate' });
    if (!r?.ok) return schedMsg(r?.error || 'failed', 'bad');
    await applySchedule(r.intervals);
  };
  document.getElementById('schedAdd').onclick = () => {
    const last = schedView.intervals.at(-1);
    const from = last ? toMin(last.end) + 30 : toMin(form.querySelector('[data-path="schedule.dayStart"]').value);
    schedView.intervals.push({ start: hhmm(from), end: hhmm(from + 60) });
    dirty();
    renderSchedList();
  };
  document.getElementById('schedSave').onclick = () => applySchedule(schedView.intervals);
  document.getElementById('schedUndo').onclick = () => {
    dirty(false);
    schedMsg('');
    loadSched();
  };
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch.schedule || ch.nextSchedule || ch.schedHold || ch.settings)) loadSched();
  });
  setInterval(loadSched, 30_000); // "working now" / "between intervals" moves with the clock
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

function fill(s, prefix = '') {
  for (const el of form.querySelectorAll('[data-path]')) {
    if (!el.dataset.path.startsWith(prefix)) continue;
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

const env = await loadEnv();
let current;
build();
current = await loadSettings();
fill(current);
wireKey();
renderKey();
wireSched();
loadSched();
const hw = detectHardware();
document.getElementById('hw').textContent = `Detected: ${hw.cores} threads, ~${hw.memoryGb} GB RAM → auto profile "${resolveProfile('auto').name}". Saved changes reach a running run at its next step (input driver and profile: next Start).`;

// The key is saved only by Save key; keep whatever is stored now.
const collectAll = async () => {
  const s = collect(current);
  s.analyzer.apiKey = (await loadSettings()).analyzer.apiKey;
  return s;
};

document.getElementById('save').onclick = async () => {
  current = await collectAll();
  await saveSettings(current);
  msg('Saved ✓ – a running run uses it from its next step');
};
document.getElementById('reset').onclick = async () => {
  if (!confirm('Reset all settings to defaults?')) return;
  fill(await baseSettings()); // defaults with extension/.env on top
  msg('Defaults loaded – press Save to keep them');
};
document.getElementById('testBridge').onclick = async () => {
  const url = form.querySelector('[data-path="analyzer.bridgeUrl"]').value;
  const r = await chrome.runtime.sendMessage({ type: 'testBridge', url });
  msg(r.ok ? `Bridge OK · pending: ${r.health.pending?.length ?? 0}` : `Bridge error: ${r.error}`);
};
document.getElementById('testTelegram').onclick = async () => {
  await saveSettings(await collectAll());
  const r = await chrome.runtime.sendMessage({ type: 'testTelegram' });
  msg(r.ok ? 'Telegram message sent ✓' : `Telegram error: ${r.error}`);
};

// ---------- registration with the relay server ----------

const REG_TEXT = {
  none: 'Not registered',
  pending: 'Waiting for approval…',
  registered: 'Registered – watching for leads',
  ready: 'Registered – channel allocated',
  rejected: 'Declined',
};

function renderRelay(r, { prefill = false } = {}) {
  if (prefill) {
    document.getElementById('regName').value = r.name || '';
    document.getElementById('regUrl').value = r.url || env.RELAY_URL || DEFAULT_RELAY_URL;
  }
  const el = document.getElementById('regStatus');
  el.textContent = REG_TEXT[r.status] || r.status;
  el.className = `reg-status ${r.status}`;
  const lines = [];
  if (r.status === 'pending') {
    lines.push('The request is on the server. It is approved there by a person; this page updates by itself.');
    if (r.fingerprint) lines.push(`Fingerprint: ${r.fingerprint} – the server shows the same code next to the request.`);
  }
  if (r.workerId) lines.push(`ID from the server: ${r.workerId}`);
  if (r.status === 'registered') lines.push('Leads arrive once the server has put it in a channel (the server does not say which, so the channel shows here after the first lead).');
  if (r.status === 'ready') lines.push(`Channel: ${r.channels.map((c) => '#' + c).join(', ')} – leads are fetched from here.`);
  if (r.status === 'rejected') lines.push('The server declined the request (or it expired). Register again to ask once more.');
  if (r.error) lines.push(`⚠ ${r.error}`);
  document.getElementById('regDetail').textContent = lines.join('\n');
  document.getElementById('forget').disabled = r.status === 'none';
}

document.getElementById('register').onclick = async () => {
  const name = document.getElementById('regName').value.trim();
  const url = document.getElementById('regUrl').value.trim();
  const { state: st } = await chrome.runtime.sendMessage({ type: 'getState' });
  if (st.relay.status !== 'none' && !confirm('This replaces the current registration with a new request. Continue?')) return;
  const el = document.getElementById('regStatus');
  // The server sends no CORS headers, so the extension can only reach it with host access to its site.
  // Chrome lets a user limit site access (Details → Site access), so ask for this one site explicitly.
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    el.textContent = 'The server URL is not valid.';
    el.className = 'reg-status err';
    return;
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  if (!granted) {
    el.textContent = `No access to ${origin} – allow it (Details → Site access) and try again.`;
    el.className = 'reg-status err';
    return;
  }
  el.textContent = 'Sending…';
  el.className = 'reg-status pending';
  const r = await chrome.runtime.sendMessage({ type: 'relayRegister', name, url });
  if (!r.ok) {
    el.textContent = r.error;
    el.className = 'reg-status err';
  }
};
document.getElementById('forget').onclick = async () => {
  if (!confirm('Forget this registration? The extension stops taking URLs from the server until it is registered again.')) return;
  await chrome.runtime.sendMessage({ type: 'relayForget' });
};

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'state' && m.state.relay) renderRelay(m.state.relay);
});
{
  const r = await chrome.runtime.sendMessage({ type: 'getState' });
  if (r?.ok) renderRelay(r.state.relay, { prefill: true });
}
