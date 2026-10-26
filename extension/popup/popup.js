const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let state = null;

function render() {
  if (!state) return;
  const s = state.status;
  $('status').textContent = s === 'waiting_ai' ? 'waiting AI' : s;
  $('status').className = `pill ${s}`;
  $('tabTitle').textContent = state.tabTitle || (state.tabId ? `tab #${state.tabId}` : '— none —');
  const active = s !== 'idle';
  $('start').disabled = active || !state.tabId;
  $('pause').disabled = !active || s === 'paused';
  $('resume').disabled = s !== 'paused';
  $('stop').disabled = !active;
  $('link').disabled = active;
  for (const k of ['cycles', 'analyses', 'actions', 'events']) $(k).textContent = state.stats[k];
  const bits = [];
  if (state.profile) bits.push(`profile ${state.profile}`);
  if (state.driver) bits.push(`driver ${state.driver}`);
  if (state.analyzer) bits.push(`AI ${state.analyzer}`);
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
