const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let state = null;

const RELAY_PILL = {
  none: ['not registered', 'idle'],
  rejected: ['declined', 'stopped'],
  pending: ['approval…', 'break'],
  registered: ['watching', 'waiting'],
  ready: ['watching', 'waiting'],
};

function render() {
  if (!state) return;
  const s = state.status;
  // While idle, the pill says where the server registration stands: "watching" = waiting for the server's trigger.
  const idle = s === 'idle' && state.source === 'server' && RELAY_PILL[state.relay?.status];
  const [text, cls] = idle ? (state.relay.status === 'ready' && state.blocked ? ['stopped', 'stopped'] : idle) : [s === 'waiting_ai' ? 'waiting AI' : s, s];
  $('status').textContent = text;
  $('status').className = `pill ${cls}`;
  $('status').title = state.relay?.name ? `${state.relay.name} · ${state.relay.status}` : '';
  $('name').textContent = state.relay?.name || '';
  $('tabTitle').textContent = state.tabTitle || (state.tabId ? `tab #${state.tabId}` : '— none —');
  const active = s !== 'idle';
  $('start').disabled = active || !state.tabId;
  $('pause').disabled = !active || s === 'paused';
  $('resume').disabled = s !== 'paused';
  $('stop').disabled = !active;
  $('link').disabled = active;
  $('link').textContent = state.tabId ? 'Drop linked tab' : 'Link this tab';
  for (const k of ['cycles', 'analyses', 'actions', 'events']) $(k).textContent = state.stats[k];
  const bits = [];
  if (state.feed && active) bits.push(`page ${state.feed.index + 1}/${state.feed.total}`);
  if (state.queued) bits.push(`${state.queued} lead${state.queued > 1 ? 's' : ''} in queue`);
  if (state.profile) bits.push(`profile ${state.profile}`);
  if (state.driver) bits.push(`driver ${state.driver}`);
  if (state.analyzer) bits.push(`AI ${state.analyzer}`);
  if (state.stats.cost) bits.push(`≈$${state.stats.cost.toFixed(2)} spent`);
  if (state.nextBreakAt && active) bits.push(`break ~${new Date(state.nextBreakAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  $('meta').textContent = bits.join(' · ');
  $('summary').textContent = state.lastSummary || '';
  $('error').textContent = state.error || '';
  $('error').classList.toggle('hidden', !state.error);
  $('waiting').classList.toggle('hidden', s !== 'waiting_ai');
}

function addLog(line) {
  const el = document.createElement('div');
  el.className = line.level;
  const t = new Date(line.t).toLocaleTimeString();
  el.textContent = `${t} ${line.msg}${line.data !== undefined ? ' ' + JSON.stringify(line.data) : ''}`;
  const box = $('log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  box.appendChild(el);
  while (box.children.length > 200) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function act(type, extra = {}) {
  const r = await send({ type, ...extra });
  if (!r?.ok) {
    $('error').textContent = r?.error || 'failed';
    $('error').classList.remove('hidden');
  }
}

$('start').onclick = () => act('start');
$('pause').onclick = () => act('pause');
$('resume').onclick = () => act('resume');
$('stop').onclick = () => act('stop');
$('clear').onclick = () => {
  $('log').textContent = '';
  act('clearLogs');
};
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('link').onclick = async () => {
  if (state?.tabId) return act('unlinkTab');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) act('linkTab', { tabId: tab.id });
};

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'state') {
    state = m.state;
    render();
  } else if (m.type === 'log') addLog(m.line);
});

setInterval(() => {
  if (state?.aiWaitingSince) $('waitSec').textContent = `${Math.round((Date.now() - state.aiWaitingSince) / 1000)}s`;
}, 1000);

(async () => {
  const r = await send({ type: 'getState' });
  if (!r?.ok) return;
  state = r.state;
  render();
  r.logs.slice(-150).forEach(addLog);
})();
