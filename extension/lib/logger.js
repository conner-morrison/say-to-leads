// Ring-buffer logger. Lines are kept in chrome.storage.session (survives popup
// close, cleared on browser restart) and pushed live to an open popup.

const MAX_LINES = 300;
let lines = [];
let flushTimer = null;
let verbose = true;

export function setVerbose(v) {
  verbose = !!v;
}

function push(level, msg, data) {
  const line = { t: Date.now(), level, msg: String(msg), data: data === undefined ? undefined : safe(data) };
  lines.push(line);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  (level === 'error' ? console.error : console.log)(`[STL][${level}] ${msg}`, data ?? '');
  chrome.runtime.sendMessage({ type: 'log', line }).catch(() => {});
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      chrome.storage.session.set({ logs: lines }).catch(() => {});
    }, 1000);
  }
}

function safe(d) {
  try {
    const s = JSON.stringify(d);
    return s && s.length > 2000 ? s.slice(0, 2000) + '…' : JSON.parse(s);
  } catch {
    return String(d);
  }
}

export const log = {
  info: (m, d) => push('info', m, d),
  warn: (m, d) => push('warn', m, d),
  error: (m, d) => push('error', m, d),
  debug: (m, d) => verbose && push('debug', m, d),
};

export async function getLogs() {
  if (lines.length) return lines;
  const { logs } = await chrome.storage.session.get('logs');
  lines = logs || [];
  return lines;
}

export function clearLogs() {
  lines = [];
  chrome.storage.session.set({ logs: [] }).catch(() => {});
}
