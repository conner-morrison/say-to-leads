// Per-PC values from extension/.env (gitignored; template in .env.example). They fill settings the user
// left empty, so a fresh install on another PC needs no typing. Values saved in Settings win.

// .env key → settings path
export const ENV_KEYS = {
  ANALYZER_MODE: 'analyzer.mode',
  ANTHROPIC_API_KEY: 'analyzer.apiKey',
  ANTHROPIC_MODEL: 'analyzer.model',
  ANALYZER_EFFORT: 'analyzer.effort',
  BRIDGE_URL: 'analyzer.bridgeUrl',
  TELEGRAM_BOT_TOKEN: 'telegram.botToken',
  TELEGRAM_CHAT_ID: 'telegram.chatId',
};

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim(); // inline comment after an unquoted value
    out[m[1]] = v;
  }
  return out;
}

let cached;

// The packaged .env as an object ({} when the file is missing).
export function loadEnv() {
  cached ??= fetch(chrome.runtime.getURL('.env'))
    .then((r) => (r.ok ? r.text() : ''))
    .then(parseEnv)
    .catch(() => ({}));
  return cached;
}
