// Engine: the run loop (capture → detect change → analyze → act like a human → wait),
// run control, schedule/breaks, Telegram, and messaging with popup/options/content.

import { loadSettings } from './lib/settings.js';
import { resolveProfile, detectHardware } from './lib/profiles.js';
import { RunControl, StopSignal } from './lib/control.js';
import { log, getLogs, clearLogs, setVerbose } from './lib/logger.js';
import { captureTab, diffThumbs, blobToBase64 } from './lib/capture.js';
import { analyze, bridgeHealth, buildUserText, estimateCost, mirrorTurn } from './lib/analyzer.js';
import { Telegram } from './lib/telegram.js';
import { RelayClient, EMPTY as RELAY_EMPTY, leadsIn } from './lib/relay.js';
import { CdpBackend, DomBackend, HumanInput } from './lib/input.js';
import { humanBetween, pointInBox, jitterPoint, chance, rnd, clamp } from './lib/human.js';

const state = {
  status: 'idle', // idle | running | paused | break | waiting_ai
  tabId: null,
  tabTitle: '',
  startedAt: null,
  profile: null,
  driver: null,
  analyzer: null,
  stats: { cycles: 0, analyses: 0, actions: 0, events: 0, cost: 0 },
  lastSummary: '',
  nextBreakAt: null,
  aiWaitingSince: null,
  error: null,
  blocked: false, // set by an error alarm: no automatic start until a human presses Start
  relay: { ...RELAY_EMPTY }, // registration with the relay server (see lib/relay.js)
  source: 'server', // where URLs come from: 'server' (relay queue) | 'urls' (Settings list)
  queued: 0, // URLs from the server waiting in the queue
};

const ctl = new RunControl((status) => {
  state.status = status;
  if (status !== 'waiting_ai') state.aiWaitingSince = null;
  publish();
});

let run = null; // per-run context, null while idle
let keepAlive = null;

function publish() {
  chrome.storage.session.set({ state }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

const sendToTab = (tabId, m) => chrome.tabs.sendMessage(tabId, { stl: true, ...m }, { frameId: 0 });

// Restore the linked tab after a service-worker restart.
(async () => {
  const { state: saved } = await chrome.storage.session.get('state');
  if (saved) {
    state.tabId = saved.tabId;
    state.tabTitle = saved.tabTitle;
    state.blocked = !!saved.blocked;
    if (saved.status && saved.status !== 'idle') await halt('extension_error', 'the extension worker restarted, the run was lost');
  }
  publish();
  await applySource();
  await relay.load();
  maybeAutoStart();
})();

// ---------- relay server ----------

const relay = new RelayClient({
  onChange: (v) => {
    state.relay = v;
    syncRelayKeepAlive();
    publish();
  },
  onTrigger: () => onServerTrigger().catch((e) => log.warn(`Lead fetch failed: ${e.message}`)),
});

// The long poll alone does not keep an MV3 worker alive; a periodic extension call does. The alarm
// wakes a worker that was stopped anyway, and loading the module resumes the poll.
let relayKeepAlive = null;
function syncRelayKeepAlive() {
  const on = ['pending', 'registered', 'ready'].includes(state.relay.status);
  if (on && !relayKeepAlive) {
    relayKeepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
    chrome.alarms.create('relay', { periodInMinutes: 1 });
  } else if (!on && relayKeepAlive) {
    clearInterval(relayKeepAlive);
    relayKeepAlive = null;
    chrome.alarms.clear('relay');
  }
}
chrome.alarms.onAlarm.addListener((a) => a.name === 'relay' && relay.ensureLoop());

// Settings → Feed & job → "URLs come from": the server (registration + lead queue) or the URL list.
async function applySource() {
  const s = await loadSettings();
  state.source = s.task.source;
  syncWatch();
  state.queued = (await readQueue()).length;
  publish();
}
chrome.storage.onChanged.addListener((ch, area) => area === 'local' && ch.settings && applySource());

// "Watching": idle in server mode, holding a question open for the server's "new leads" trigger.
// While a run works through its queue, triggers are ignored (not even asked for); the run fetches
// the next leads itself when the queue is empty.
function syncWatch() {
  relay.setConsume(state.source === 'server' && !run);
}

// ---------- lead queue (server mode) ----------
//
// Leads wait in a persistent FIFO queue (chrome.storage.local, survives restarts and errors).
// The head is the lead being worked on; it leaves the queue only when its page is done ("next"),
// so a run stopped by an error starts again on the same lead.

const FETCH_LIMIT = 10;
let queueOp = Promise.resolve();
async function readQueue() {
  const { relayQueue = [] } = await chrome.storage.local.get('relayQueue');
  return relayQueue.map((l) => (typeof l === 'string' ? { url: l, name: null, key: l } : l)); // older versions stored bare URLs
}
function withQueue(fn) {
  const op = queueOp.then(async () => {
    const q = await readQueue();
    const out = await fn(q);
    await chrome.storage.local.set({ relayQueue: q });
    state.queued = q.length;
    if (run?.server && state.feed) state.feed.total = Math.max(state.feed.index, 0) + q.length;
    return out;
  });
  queueOp = op.catch(() => {});
  return op;
}

// Fetch up to 10 leads from right after the last fetch: queue them, reply "fetched" to each lead on the
// server, then acknowledge, which moves this extension's cursor past them. Returns how many were queued.
let fetchOp = Promise.resolve(0);
function fetchLeads() {
  const op = fetchOp.then(async () => {
    const { messages } = await relay.get({ limit: FETCH_LIMIT });
    if (!messages.length) return 0;
    const last = {};
    const leads = [];
    for (const m of messages) {
      if (m.channel && Number.isFinite(m.seq)) last[m.channel] = Math.max(last[m.channel] ?? -Infinity, m.seq);
      if (m.sender && m.sender === state.relay.workerId) continue; // our own replies
      if (m.body && typeof m.body === 'object' && m.body.status === 'fetched') continue; // anyone's fetched marks
      const found = leadsIn(m);
      if (!found.length) log.info(`Server message #${m.seq} has no lead (trigger or note) – skipped`);
      leads.push(...found);
    }
    const added = await withQueue((q) => {
      const have = new Set(q.map((l) => l.key));
      const fresh = leads.filter((l) => !have.has(l.key));
      q.push(...fresh);
      return fresh;
    });
    for (const l of added) {
      const reply = { status: 'fetched', url: l.url, ...(l.name && { name: l.name }), ...(l.job && { job_id: l.job }), reply_to: l.seq, by: state.relay.name };
      await relay.publish(l.channel, reply, `fetched:${l.key}`).catch((e) => log.warn(`Fetched mark for ${l.name || l.url} failed: ${e.message}`));
    }
    await relay.ack(last);
    if (added.length) await bumpStats({ fetched: added.length });
    log.info(`Fetched ${added.length} lead(s) from the server – ${state.queued} in the queue`, added.map((l) => l.name || l.url));
    publish();
    return added.length;
  });
  fetchOp = op.catch(() => 0);
  return op;
}

// The server's trigger while watching: fetch, then start working if anything came.
async function onServerTrigger() {
  if (run || state.source !== 'server') return; // a run ignores triggers; it fetches when its queue is empty
  if ((await readQueue()).length) return maybeAutoStart(); // leads still to do (e.g. stopped by an error) come first
  const n = await fetchLeads();
  if (n) maybeAutoStart();
}

async function maybeAutoStart() {
  if (ctl.active || run || state.blocked || state.source !== 'server' || !state.relay.workerId) return;
  const q = await readQueue();
  state.queued = q.length;
  if (!q.length) return;
  if (!state.tabId) {
    log.warn(`${q.length} lead(s) are waiting – link a tab and press Start`);
    return publish();
  }
  await start().catch((e) => {
    log.warn(`Could not start on the queued leads: ${e.message}`);
    state.error = e.message;
    publish();
  });
}

// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.stl || msg.type === 'log' || msg.type === 'state') return;
  handle(msg, sender)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'getState':
      return { state, logs: await getLogs(), hardware: detectHardware(), autoProfile: resolveProfile('auto').name };
    case 'linkTab': {
      if (ctl.active) throw new Error('Stop the run before linking another tab.');
      const tab = await chrome.tabs.get(msg.tabId);
      state.tabId = tab.id;
      state.tabTitle = tab.title;
      state.error = null;
      log.info(`Linked tab: ${tab.title}`);
      publish();
      return {};
    }
    case 'unlinkTab':
      if (ctl.active) throw new Error('Stop the run before dropping the linked tab.');
      log.info(`Dropped linked tab: ${state.tabTitle}`);
      Object.assign(state, { tabId: null, tabTitle: '', error: null });
      publish();
      return {};
    case 'start':
      state.blocked = false; // a human checked and starts again
      await start();
      return {};
    case 'relayRegister':
      await relay.register(msg.url, msg.name);
      return {};
    case 'relayForget':
      await relay.forget();
      return {};
    case 'stop':
      await stop('stopped by user');
      return {};
    case 'pause':
      ctl.pause();
      log.info('Paused');
      return {};
    case 'resume':
      ctl.resume();
      log.info('Resumed');
      return {};
    case 'clearLogs':
      clearLogs();
      return {};
    case 'testTelegram': {
      const s = await loadSettings();
      const ok = await new Telegram({ ...s.telegram, enabled: true }).send('✅ Say To Leads: Telegram test message', null, { dedupe: false });
      if (!ok) throw new Error('Send failed – check bot token / chat id (see log).');
      return {};
    }
    case 'testBridge': {
      const s = await loadSettings();
      return { health: await bridgeHealth(msg.url || s.analyzer.bridgeUrl) };
    }
    case 'page-event':
      if (sender.tab?.id === state.tabId && run) onPageEvent(msg.event);
      return {};
  }
  throw new Error(`unknown message ${msg.type}`);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.tabId) return;
  if (ctl.active) stop('linked tab was closed');
  else {
    Object.assign(state, { tabId: null, tabTitle: '' });
    publish();
  }
});

// ---------- lifecycle ----------

async function start() {
  if (ctl.active) return;
  if (!state.tabId) throw new Error('Link a tab first.');
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab) throw new Error('Linked tab no longer exists – link a tab again.');

  const settings = await loadSettings();
  const server = settings.task.source === 'server';
  if (server && !state.relay.workerId) {
    throw new Error({
      none: 'Register this extension with the server first (Settings → Registration).',
      rejected: 'The server declined the registration – register again (Settings → Registration).',
      pending: 'Waiting for the server to approve the registration.',
    }[state.relay.status] || 'Not registered with the server.');
  }

  // Server mode: leads not handled yet come first; with none, fetch the next ones from the server.
  // With nothing there either, there is no run: the extension watches for the server's trigger.
  let queue = server ? await readQueue() : [];
  if (server && !queue.length && (await fetchLeads())) queue = await readQueue();
  if (server && !queue.length) {
    log.info('No leads on the server – watching for new ones');
    syncWatch();
    return publish();
  }
  const feed = server ? [] : parseFeed(settings.task.feed);
  if (/^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) throw new Error('Browser internal pages cannot be automated.');

  setVerbose(settings.debug.verbose);
  const profile = resolveProfile(settings.performance.profile);
  const backend = settings.input.driver === 'dom' ? new DomBackend(tab.id) : new CdpBackend(tab.id, onDebuggerDetached);
  await backend.init(); // fails if DevTools is open on that tab

  const telegram = new Telegram(settings.telegram);
  run = {
    settings,
    profile,
    backend,
    telegram,
    input: new HumanInput(backend, { profile, human: settings.human, ctl, tabId: tab.id, showCursor: settings.input.showCursor }),
    feed,
    server,
    feedIndex: -1, // nothing opened yet; the first "next" opens feed[0]
    nextPage: false, // set by the "next" action, handled at the end of the cycle
    pick: pickMessage(settings), // saved first message to use on the current page (random per page)
    events: [],
    history: [],
    lastThumb: null,
    lastAnalysisAt: 0,
    lastActions: [],
    actionTimes: [],
    nextBreakAt: 0,
  };
  Object.assign(state, {
    startedAt: Date.now(),
    profile: profile.name,
    driver: backend.kind,
    analyzer: settings.analyzer.mode,
    error: null,
    lastSummary: '',
    stats: { cycles: 0, analyses: 0, actions: 0, events: 0, cost: 0 },
    feed: server ? { index: -1, total: queue.length, url: queue[0].url } : feed.length ? { index: -1, total: feed.length, url: feed[0] } : null,
  });
  syncWatch(); // a run ignores the server's triggers
  scheduleBreak();
  ctl.start();
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000); // keeps the MV3 worker alive while running

  log.info(`Started · profile=${profile.name} · analyzer=${settings.analyzer.mode} · driver=${backend.kind}`);

  loop()
    .catch((e) => {
      if (e instanceof StopSignal || ctl.stopped) return;
      return halt('extension_error', `loop crashed: ${e.message}`);
    })
    .finally(cleanup);
}

async function stop(reason) {
  if (!ctl.active) return;
  log.info(`Stopped: ${reason}`);
  ctl.stop();
}

// Error alarms. Each one stops the run (whether or not its Telegram alarm is on), so a human
// checks what happened and presses Start again.
const ALERTS = {
  weekly_limit: ['weeklyLimit', '⛔ Weekly limit'],
  linkedin_error: ['linkedinError', '⚠️ LinkedIn error'],
  extension_error: ['extensionError', '❌ Extension error'],
};

async function halt(kind, text, photo = null) {
  const [key, label] = ALERTS[kind];
  (kind === 'extension_error' ? log.error : log.warn)(`${label}: ${text}`);
  state.error = `${label}: ${text} – check, then press Start.`;
  state.blocked = true;
  const settings = run?.settings ?? (await loadSettings());
  if (settings.telegram.alerts[key]) {
    const tg = run?.telegram ?? new Telegram(settings.telegram);
    await tg.send(`${label}: ${text}\nThe run stopped – check and press Start again.`, photo, { dedupe: false }).catch(() => {});
    if (kind === 'weekly_limit') await sendWeeklySummary(tg);
  }
  await stop(label);
  publish();
}

// ---------- weekly summary ----------
// Lead results since the last weekly-limit stop. When LinkedIn's weekly limit stops the run, they go to
// Telegram as a table and start again from zero for the next week.

const OUTCOME_FIELD = { sent: 'sent', pending: 'pending', error: 'error' };
let statsOp = Promise.resolve();
function bumpStats(delta) {
  statsOp = statsOp.then(async () => {
    const { weekStats: w = { since: Date.now(), fetched: 0, sent: 0, pending: 0, error: 0 } } = await chrome.storage.local.get('weekStats');
    for (const [k, n] of Object.entries(delta)) w[k] = (w[k] || 0) + n;
    await chrome.storage.local.set({ weekStats: w });
  }).catch((e) => log.warn(`Weekly stats not saved: ${e.message}`));
  return statsOp;
}

async function sendWeeklySummary(tg) {
  await statsOp;
  const { weekStats: w = { since: Date.now(), fetched: 0, sent: 0, pending: 0, error: 0 } } = await chrome.storage.local.get('weekStats');
  // Left = leads not done yet; the one the limit stopped on is still at the head of the queue.
  const left = run?.server || !run ? (await readQueue()).length : Math.max(run.feed.length - Math.max(run.feedIndex, 0), 0);
  const notSent = [`${w.error} error`, `${w.pending} pending`, `${left} left`];
  const cols = [['Fetched', [String(w.fetched)]], ['Not sent', notSent], ['Sent', [String(w.sent)]]];
  const width = cols.map(([h, v]) => Math.max(h.length, ...v.map((x) => x.length)));
  const row = (cells) => `| ${cells.map((c, i) => c.padEnd(width[i])).join(' | ')} |`;
  const lines = [row(cols.map(([h]) => h)), row(width.map((n) => '-'.repeat(n)))];
  for (let i = 0; i < notSent.length; i++) lines.push(row(cols.map(([, v]) => v[i] ?? '')));
  const since = new Date(w.since).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ok = await tg.send(`📊 <b>This week's connections</b> (since ${since})\n<pre>${esc(lines.join('\n'))}</pre>`, null, { dedupe: false, html: true });
  log.info('Weekly summary', { ...w, left });
  if (ok) await chrome.storage.local.set({ weekStats: { since: Date.now(), fetched: 0, sent: 0, pending: 0, error: 0 } });
}

async function cleanup() {
  clearInterval(keepAlive);
  keepAlive = null;
  const r = run;
  run = null;
  if (ctl.active) ctl.stop();
  if (r) {
    r.telegram.stopPolling();
    await r.backend.dispose();
  }
  publish();
  syncWatch(); // idle again: watch for the server's trigger
}

function onDebuggerDetached(reason) {
  log.warn(`Debugger detached (${reason})`);
  if (!ctl.active) return;
  halt('extension_error', reason === 'target_closed' ? 'the linked tab was closed' : `debugger detached (${reason})`);
}

// ---------- feed ----------

// One URL per line; blank lines and #comments are skipped, a missing scheme means https.
function parseFeed(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      let u = null;
      try {
        u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(l) ? l : `https://${l}`);
      } catch {}
      if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`Feed line is not a web URL: ${l}`);
      return u.href;
    });
}

// Open a URL in the linked tab and wait until it has loaded (or give up after 45 s).
async function navigate(tabId, url) {
  const loaded = new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(() => {
      log.warn(`Page still loading after 45 s, continuing: ${url}`);
      done();
    }, 45_000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

// Move the linked tab to feed entry i, or end the run after the last one.
async function openFeedPage(i) {
  if (run.server) {
    // The lead before is done: it leaves the queue now (not when it opened), so an error keeps it queued.
    const done = run.lead;
    if (done) await withQueue((q) => q[0]?.key === done.key && q.shift());
    run.lead = null;
    let q = await readQueue();
    if (!q.length && (await fetchLeads())) q = await readQueue(); // queue done → the next leads from the server
    if (q.length) {
      run.lead = q[0];
      run.feed.push(q[0].url);
    }
  }
  const { feed } = run;
  if (i >= feed.length) {
    log.info(run.server ? `All leads done (${feed.length} this run) – watching the server for new ones` : `Feed finished (${feed.length} pages)`);
    await stop(run.server ? 'queue empty' : 'feed finished');
    throw new StopSignal();
  }
  await ctl.sleep(humanBetween(1500, 4000)); // a person pauses before moving on
  run.feedIndex = i;
  const total = run.server ? i + state.queued : feed.length;
  state.feed = { index: i, total, url: feed[i] };
  log.info(`Feed ${i + 1}/${total}: ${run.lead?.name ? `${run.lead.name} – ` : ''}${feed[i]}`);
  await navigate(state.tabId, feed[i]);
  // Fresh page, fresh short-term memory; analyze it right away.
  Object.assign(run, { history: [], lastActions: [], lastThumb: null, lastAnalysisAt: 0, events: [], pick: pickMessage(run.settings) });
  publish();
}

// ---------- schedule ----------

function pickMessage(settings) {
  const n = settings.messages.first.length;
  return n ? Math.floor(Math.random() * n) : null;
}

function scheduleBreak() {
  const h = run.settings.human;
  run.nextBreakAt = Date.now() + humanBetween(h.breakEveryMinMin, h.breakEveryMaxMin) * 60_000;
  state.nextBreakAt = h.breaksEnabled ? run.nextBreakAt : null;
}

function inWorkHours(h) {
  const toMin = (s) => {
    const [a, b] = String(s).split(':').map(Number);
    return (a || 0) * 60 + (b || 0);
  };
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = toMin(h.workStart);
  const e = toMin(h.workEnd);
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e; // supports overnight windows
}

function overActionBudget() {
  const cutoff = Date.now() - 3_600_000;
  run.actionTimes = run.actionTimes.filter((t) => t > cutoff);
  return run.actionTimes.length >= run.settings.human.maxActionsPerHour;
}

// ---------- main loop ----------

async function loop() {
  while (true) {
    await ctl.checkpoint();
    const { settings, profile } = run;
    const h = settings.human;

    if (!inWorkHours(h)) {
      if (state.status !== 'break') log.info('Outside working hours – waiting');
      ctl.set('break');
      await ctl.sleep(60_000);
      continue;
    }
    if (h.breaksEnabled && Date.now() >= run.nextBreakAt) {
      const len = humanBetween(h.breakLenMinMin, h.breakLenMaxMin) * 60_000;
      log.info(`Taking a break for ~${Math.round(len / 60_000)} min`);
      ctl.set('break');
      await ctl.sleep(len);
      scheduleBreak();
      log.info('Back from break');
      continue;
    }
    if (overActionBudget()) {
      if (state.status !== 'break') log.info('Hourly action limit reached – idling');
      ctl.set('break');
      await ctl.sleep(60_000);
      continue;
    }

    ctl.set('running');
    let delay = null;
    try {
      delay = await cycle();
    } catch (e) {
      if (e instanceof StopSignal || ctl.stopped) throw new StopSignal();
      await halt('extension_error', e.message);
      throw new StopSignal();
    }
    ctl.set('running');
    publish();
    const base = delay ?? humanBetween(h.loopMinSec, h.loopMaxSec) * 1000;
    await ctl.sleep(Math.max(profile.minLoopSec * 1000, base * rnd(0.85, 1.2)), { wakeable: true });
  }
}

async function ensureContent(tabId, settings) {
  const pong = await sendToTab(tabId, { cmd: 'ping' }).catch(() => null);
  if (pong?.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content-main.js'], world: 'MAIN' });
  const w = settings.watch;
  await sendToTab(tabId, {
    cmd: 'configure',
    cfg: {
      titleBadge: w.titleBadge,
      notificationApi: w.notificationApi,
      selectors: w.selectors.split('\n').map((s) => s.trim()).filter(Boolean),
      showCursor: settings.input.showCursor,
    },
  });
  log.debug('Content scripts injected');
}

// One observe → decide → act pass. Returns the suggested delay in ms (or null for default pacing).
async function cycle() {
  const { settings, profile, input, backend } = run;
  state.stats.cycles++;

  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab) {
    await halt('extension_error', 'the linked tab was closed');
    throw new StopSignal();
  }
  if (backend.kind === 'debugger' && !backend.attached) {
    log.info('Re-attaching debugger');
    await backend.init();
  }
  await ensureContent(tab.id, settings);
  const vp = await sendToTab(tab.id, { cmd: 'viewport' });
  input.setViewport(vp);
  state.tabTitle = vp.title;

  let shot;
  try {
    shot = await captureTab(tab, { backend, profile, scale: Number(settings.analyzer.imageScale) || 1 });
  } catch (e) {
    if (e.message !== 'TAB_NOT_VISIBLE') throw e;
    log.warn('Linked tab is not visible – bring it to the front (or use the debugger driver)');
    return 10_000;
  }

  const diff = diffThumbs(run.lastThumb, shot.thumb);
  run.lastThumb = shot.thumb;
  const events = run.events.splice(0);
  const stale = Date.now() - run.lastAnalysisAt > settings.task.forceAnalyzeEverySec * 1000;
  const inbox = await inboxDue(settings);
  log.debug(`cycle ${state.stats.cycles}: diff=${Number.isFinite(diff) ? diff.toFixed(1) : '∞'} events=${events.length} stale=${stale} inbox=${!!inbox}`);

  if (diff < settings.task.changeThreshold && !events.length && !stale && !inbox) {
    await idleBehavior();
    return null;
  }
  if (settings.analyzer.mode === 'none') {
    run.lastAnalysisAt = Date.now();
    return null;
  }

  const req = {
    id: `${Date.now().toString(36)}-${state.stats.cycles}`,
    created: Date.now(),
    feed: state.feed,
    job: settings.task.job,
    firstMessages: settings.messages.first,
    pickedMessage: run.pick,
    lead: run.server && run.lead ? { name: run.lead.name, url: run.lead.url } : null,
    sendMode: settings.messages.sendMode,
    inbox,
    page: { url: vp.url, title: vp.title, viewport: { w: vp.w, h: vp.h } },
    events,
    history: run.history.slice(-settings.task.historyLength),
    lastActions: run.lastActions,
    image: { mime: 'image/jpeg', width: shot.width, height: shot.height, base64: await blobToBase64(shot.blob) },
  };

  ctl.set('waiting_ai');
  state.aiWaitingSince = Date.now();
  publish();
  log.info(`→ analyzer (${settings.analyzer.mode}) request ${req.id}`);
  const mirror = settings.analyzer.mode === 'anthropic' && settings.analyzer.mirrorToBridge;
  let result;
  try {
    result = await analyze(req, settings, ctl.signal);
  } catch (e) {
    run.events.unshift(...events); // don't lose events on a failed analysis
    if (mirror && !ctl.stopped) mirrorTurn(settings, { ...req, model: settings.analyzer.model, prompt: buildUserText(req), error: e.message });
    throw e;
  }
  ctl.set('running');
  if (result.usage) {
    const cost = estimateCost(settings.analyzer.model, result.usage);
    state.stats.cost += cost;
    const u = result.usage;
    log.debug(`tokens in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} out=${u.output_tokens} ≈ $${cost.toFixed(4)}`);
  }
  if (mirror) {
    const { usage, model, ...answer } = result;
    mirrorTurn(settings, { ...req, model, usage, prompt: buildUserText(req), result: answer });
  }

  run.lastAnalysisAt = Date.now();
  state.stats.analyses++;
  state.lastSummary = result.summary;
  log.info(`← ${result.summary}`, result.actions);
  run.history.push({ t: Date.now(), summary: result.summary, actions: result.actions.map((a) => a.type) });
  if (run.history.length > 20) run.history.shift();
  if (inbox && result.inbox) await onInboxReport(result.inbox); // no report (panel closed) → still due next cycle

  if (result.actions.length) {
    await ctl.sleep(humanBetween(400, 1500)); // look at the screen before moving
    run.lastActions = await executeActions(result.actions, vp, shot);
    run.lastThumb = null; // force a verification look next cycle
  } else {
    run.lastActions = [];
  }
  if (run.nextPage) {
    run.nextPage = false;
    await openFeedPage(run.feedIndex + 1);
    return null;
  }
  return result.next_check_sec != null ? result.next_check_sec * 1000 : null;
}

// ---------- browsing ----------
// "browse": read the page like a person, with no screenshots or AI calls. Scrolls to random depths
// anywhere in the page (the height is re-read each stop, since sections load lazily), pauses to
// "read", drifts the mouse, sometimes backtracks, and ends back at the top.

async function browsePage(sec) {
  const { input } = run;
  const vp = await sendToTab(state.tabId, { cmd: 'viewport' });
  // Keep the wheel over the main column, away from docked side panels.
  await input.move({ x: rnd(vp.w * 0.22, vp.w * 0.45), y: rnd(vp.h * 0.35, vp.h * 0.8) });
  // Measured at the mouse: the page may scroll an inner container rather than the document.
  const geo = () => sendToTab(state.tabId, { cmd: 'scrollInfo', x: input.pos.x, y: input.pos.y });
  const end = Date.now() + clamp(sec ?? rnd(25, 70), 5, 300) * 1000;
  let g = await geo();
  let first = true;
  while (Date.now() < end) {
    g = await geo();
    const maxY = Math.max(0, g.height - g.view);
    if (maxY < 50) {
      log.warn('browse: nothing to scroll here');
      break;
    }
    // The first stop goes deep so the whole page gets covered; later stops land anywhere.
    const target = first ? rnd(0.55, 1) * maxY : rnd(0, 1) * maxY;
    first = false;
    // Travel there a screen or so at a time, glancing at each part on the way.
    let left = target - g.top;
    while (Math.abs(left) > 60 && Date.now() < end) {
      const step = Math.sign(left) * Math.min(Math.abs(left), rnd(0.5, 1.1) * g.view);
      await input.scroll(step);
      left -= step;
      await ctl.sleep(humanBetween(700, 2500));
    }
    await ctl.sleep(humanBetween(1500, 6000)); // read this part
    if (chance(0.4)) await input.fidget();
    if (chance(0.25)) {
      await input.scroll(-rnd(120, 320)); // re-read something just above
      await ctl.sleep(humanBetween(800, 2500));
    }
  }
  g = await geo();
  if (g.top > 0) {
    await input.scroll(-(g.top + 200));
    await ctl.sleep(humanBetween(300, 900));
    g = await geo();
    if (g.top > 0) await input.scroll(-(g.top + 200)); // smooth-scroll lag or lazy content
  }
  await ctl.sleep(humanBetween(1000, 3000));
  log.info(`Browsed the page (${(g.height / g.view).toFixed(1)} screens)`);
}

// ---------- inbox monitor ----------
// The last seen top of the Messaging list is kept in storage, so it survives Stop/Start.

async function inboxDue(settings) {
  const min = Number(settings.monitor.inboxEveryMin) || 0;
  if (min <= 0) return null;
  const { inbox } = await chrome.storage.local.get('inbox');
  if (inbox?.at && Date.now() - inbox.at < min * 60_000) return null;
  return { lastTop: inbox?.top || null, lastAt: inbox?.at || null };
}

async function onInboxReport(r) {
  await chrome.storage.local.set({ inbox: { top: r.top, at: Date.now() } });
  log.info(`Inbox check: top=${r.top} unread=[${r.unread.join(', ')}] accepted=[${r.accepted.join(', ')}]`);
  const { alerts } = run.settings.telegram;
  const lines = [];
  if (r.unread.length && alerts.newMessage) lines.push(`💬 New message${r.unread.length > 1 ? 's' : ''} from: ${r.unread.join(', ')}`);
  if (r.accepted.length && alerts.accepted) lines.push(`🤝 Accepted your invitation: ${r.accepted.join(', ')}`);
  if (lines.length) await run.telegram.send(lines.join('\n'));
}

// While nothing changes, act like a person reading: a small mouse drift, or a short scroll
// down and back up. Both go through the humanized input layer (curved paths, scroll bursts).
async function idleBehavior() {
  const h = run.settings.human;
  if (chance(h.idleMoveChance)) await run.input.fidget();
  else if (chance(h.idleScrollChance)) {
    const d = rnd(80, 240);
    await run.input.scroll(d);
    await ctl.sleep(humanBetween(800, 3000));
    await run.input.scroll(-d);
  }
}

async function targetPoint(a, vp) {
  let box = null;
  if (a.selector) {
    const r = await sendToTab(state.tabId, { cmd: 'resolve', selector: a.selector });
    if (!r?.ok) throw new Error(r?.error || 'resolve failed');
    if (!r.inView) throw new Error('target is outside the viewport – scroll first');
    box = r.box;
  } else if (a.box) {
    box = [a.box[0] * vp.w, a.box[1] * vp.h, a.box[2] * vp.w, a.box[3] * vp.h];
  } else if (a.x != null && a.y != null) {
    return jitterPoint({ x: a.x * vp.w, y: a.y * vp.h }, 4);
  } else {
    throw new Error('no target (x/y, box or selector)');
  }
  const [x1, y1, x2, y2] = box;
  return pointInBox([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
}

const COUNTED = new Set(['click', 'double_click', 'type', 'key', 'scroll']);

async function executeActions(actions, vp, shot) {
  const { input, settings, telegram } = run;
  const h = settings.human;
  const report = [];
  for (const a of actions) {
    await ctl.checkpoint();
    const rec = { type: a.type, ok: true };
    try {
      if (COUNTED.has(a.type) || a.type === 'hover') await ctl.sleep(humanBetween(h.thinkMinMs, h.thinkMaxMs));
      switch (a.type) {
        case 'click':
        case 'double_click':
        case 'hover': {
          const pt = await targetPoint(a, vp);
          if (a.type === 'hover') await input.move(pt);
          else await input.click(pt, { double: a.type === 'double_click' });
          break;
        }
        case 'type':
          if (a.selector || a.box || a.x != null) {
            await input.click(await targetPoint(a, vp));
            await ctl.sleep(humanBetween(200, 700));
          }
          if (a.clear) await input.clearField();
          await input.type(a.text || '');
          break;
        case 'key':
          await input.press(a.key || 'Enter');
          break;
        case 'scroll':
          await input.scroll(clamp(a.dy ?? 300, -5000, 5000));
          break;
        case 'browse':
          await browsePage(a.sec);
          break;
        case 'wait':
          await ctl.sleep(clamp(a.ms ?? 1000, 0, 600_000));
          break;
        case 'notify':
          if (ALERTS[a.alert]) {
            await halt(a.alert, a.text || state.lastSummary, a.photo ? shot.blob : null);
            throw new StopSignal();
          }
          await telegram.send(`💬 ${a.text || state.lastSummary}`, a.photo ? shot.blob : null);
          break;
        case 'next':
          if (OUTCOME_FIELD[a.outcome]) await bumpStats({ [OUTCOME_FIELD[a.outcome]]: 1 });
          if (run.feed.length || run.server) run.nextPage = true;
          else log.warn('"next" ignored – the feed is empty');
          break;
        case 'pause':
          log.warn(`Analyzer paused the run: ${a.reason || a.text || ''}`);
          ctl.pause();
          break;
        case 'stop':
          await stop(`analyzer: ${a.reason || a.text || 'done'}`);
          break;
      }
      if (COUNTED.has(a.type)) {
        run.actionTimes.push(Date.now());
        state.stats.actions++;
      }
    } catch (e) {
      if (e instanceof StopSignal || ctl.stopped) throw new StopSignal();
      await halt('extension_error', `action ${a.type} failed: ${e.message}`);
      throw new StopSignal();
    }
    report.push(rec);
    if (run.nextPage) break; // the page is done; anything after "next" is skipped
  }
  return report;
}

// ---------- events & remote control ----------

async function onPageEvent(ev) {
  state.stats.events++;
  run.events.push(ev);
  if (run.events.length > 20) run.events.shift();
  log.info(`🔔 ${ev.kind}: ${ev.text}`);
  ctl.wake(); // look at the screen now instead of waiting out the idle delay
  publish();
}
