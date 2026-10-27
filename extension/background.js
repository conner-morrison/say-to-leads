// Engine: the run loop (capture → detect change → analyze → act like a human → wait),
// run control, schedule/breaks, Telegram, and messaging with popup/options/content.

import { loadSettings } from './lib/settings.js';
import { resolveProfile, detectHardware } from './lib/profiles.js';
import { RunControl, StopSignal } from './lib/control.js';
import { log, getLogs, clearLogs, setVerbose } from './lib/logger.js';
import { captureTab, diffThumbs, blobToBase64 } from './lib/capture.js';
import { analyze, bridgeHealth } from './lib/analyzer.js';
import { Telegram } from './lib/telegram.js';
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
  stats: { cycles: 0, analyses: 0, actions: 0, events: 0 },
  lastSummary: '',
  nextBreakAt: null,
  aiWaitingSince: null,
  error: null,
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
    if (saved.status && saved.status !== 'idle') {
      state.error = 'Extension worker restarted – press Start to continue.';
      log.warn(state.error);
    }
  }
  publish();
})();

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
    case 'start':
      await start();
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
  if (tabId === state.tabId && ctl.active) stop('linked tab was closed');
});

// ---------- lifecycle ----------

async function start() {
  if (ctl.active) return;
  if (!state.tabId) throw new Error('Link a tab first.');
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab) throw new Error('Linked tab no longer exists – link a tab again.');

  const settings = await loadSettings();
  const feed = parseFeed(settings.task.feed);
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
    feedIndex: -1, // nothing opened yet; the first "next" opens feed[0]
    nextPage: false, // set by the "next" action, handled at the end of the cycle
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
    stats: { cycles: 0, analyses: 0, actions: 0, events: 0 },
    feed: feed.length ? { index: -1, total: feed.length, url: feed[0] } : null,
  });
  scheduleBreak();
  ctl.start();
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000); // keeps the MV3 worker alive while running

  log.info(`Started · profile=${profile.name} · analyzer=${settings.analyzer.mode} · driver=${backend.kind}`);
  if (settings.telegram.notifyOnStartStop) telegram.send(`▶️ Started on: ${tab.title}`, null, { dedupe: false });
  telegram.startPolling(onTelegramCommand);

  loop()
    .catch((e) => {
      if (e instanceof StopSignal || ctl.stopped) return;
      log.error('Loop crashed', e.message);
      state.error = e.message;
      run?.telegram.send(`❌ Crashed: ${e.message}`, null, { dedupe: false });
    })
    .finally(cleanup);
}

async function stop(reason) {
  if (!ctl.active) return;
  log.info(`Stopped: ${reason}`);
  if (run?.settings.telegram.notifyOnStartStop) await run.telegram.send(`⏹ Stopped: ${reason}`, null, { dedupe: false });
  ctl.stop();
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
}

function onDebuggerDetached(reason) {
  log.warn(`Debugger detached (${reason})`);
  if (!ctl.active) return;
  if (reason === 'target_closed') return stop('linked tab was closed');
  ctl.pause();
  run?.telegram.send(`⚠️ Debugger detached (${reason}) – run paused. Press Resume to re-attach.`, null, { dedupe: false });
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
  const { feed } = run;
  if (i >= feed.length) {
    log.info(`Feed finished (${feed.length} pages)`);
    await stop('feed finished');
    throw new StopSignal();
  }
  await ctl.sleep(humanBetween(1500, 4000)); // a person pauses before moving on
  run.feedIndex = i;
  state.feed = { index: i, total: feed.length, url: feed[i] };
  log.info(`Feed ${i + 1}/${feed.length}: ${feed[i]}`);
  await navigate(state.tabId, feed[i]);
  // Fresh page, fresh short-term memory; analyze it right away.
  Object.assign(run, { history: [], lastActions: [], lastThumb: null, lastAnalysisAt: 0, events: [] });
  publish();
}

// ---------- schedule ----------

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
      log.error('Cycle error', e.message);
      state.error = e.message;
      delay = 15_000;
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
    await stop('linked tab was closed');
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
    firstMessages: settings.messages.first,
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
  let result;
  try {
    result = await analyze(req, settings, ctl.signal);
  } catch (e) {
    run.events.unshift(...events); // don't lose events on a failed analysis
    throw e;
  }
  ctl.set('running');

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
  const lines = [];
  if (r.unread.length) lines.push(`💬 New message${r.unread.length > 1 ? 's' : ''} from: ${r.unread.join(', ')}`);
  if (r.accepted.length) lines.push(`🤝 Accepted your invitation: ${r.accepted.join(', ')}`);
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
        case 'wait':
          await ctl.sleep(clamp(a.ms ?? 1000, 0, 600_000));
          break;
        case 'notify':
          await telegram.send(`💬 ${a.text || state.lastSummary}`, a.photo ? shot.blob : null);
          break;
        case 'next':
          if (run.feed.length) run.nextPage = true;
          else log.warn('"next" ignored – the feed is empty');
          break;
        case 'pause':
          log.warn(`Analyzer paused the run: ${a.reason || a.text || ''}`);
          await telegram.send(`⏸ Paused by analyzer: ${a.reason || a.text || ''}`, null, { dedupe: false });
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
      if (e instanceof StopSignal) throw e;
      rec.ok = false;
      rec.error = e.message;
      log.warn(`Action ${a.type} failed`, e.message);
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
  const tg = run.settings.telegram;
  if (tg.notifyOnEvents) {
    let photo = null;
    if (tg.sendScreenshotOnEvent) {
      photo = await captureTab({ id: state.tabId }, run)
        .then((s) => s.blob)
        .catch(() => null);
    }
    run?.telegram.send(`🔔 ${ev.text}`, photo);
  }
  ctl.wake(); // look at the screen now instead of waiting out the idle delay
  publish();
}

function statusText() {
  const up = state.startedAt ? Math.round((Date.now() - state.startedAt) / 60_000) : 0;
  const s = state.stats;
  const f = state.feed;
  const feed = !f ? '' : f.index < 0 ? `\nFeed: ${f.total} pages, none opened yet` : `\nFeed: page ${f.index + 1}/${f.total} ${f.url}`;
  return `Status: ${state.status}\nTab: ${state.tabTitle}${feed}\nUptime: ${up} min\nCycles ${s.cycles} · AI ${s.analyses} · actions ${s.actions} · events ${s.events}\nLast: ${state.lastSummary || '-'}`;
}

async function onTelegramCommand(cmd) {
  const tg = run?.telegram;
  if (!tg) return;
  const reply = (t, p) => tg.send(t, p, { dedupe: false });
  log.info(`Telegram command ${cmd}`);
  switch (cmd) {
    case '/pause':
      ctl.pause();
      return reply('⏸ Paused');
    case '/resume':
      ctl.resume();
      return reply('▶️ Resumed');
    case '/stop':
      return stop('Telegram command');
    case '/status':
      return reply(statusText());
    case '/shot': {
      const shot = await captureTab({ id: state.tabId }, run).catch((e) => ({ error: e.message }));
      return shot.blob ? reply(state.tabTitle, shot.blob) : reply(`Screenshot failed: ${shot.error}`);
    }
    default:
      return reply('Commands: /status /pause /resume /stop /shot');
  }
}
