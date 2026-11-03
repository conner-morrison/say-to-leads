// The Claude API key: its check and its status line (Settings → Analyzer enters it, the popup shows it).
// The key is never shown back, only its last 4 characters and where it comes from.

export const mask = (k) => (k ? `…${k.slice(-4)}` : '');

// A cheap check that costs no tokens: listing the models needs a valid key.
// The result is kept as apiKeyCheck, matched to the key by its last 4 characters.
export async function checkKey(key) {
  let r;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) r = { ok: false, error: 'the API rejected this key' };
    else r = { ok: true, verified: res.ok, note: res.ok ? 'key works' : `could not fully check it (HTTP ${res.status})` };
  } catch (e) {
    r = { ok: true, verified: false, note: `could not check it (${e.message})` };
  }
  await chrome.storage.local.set({ apiKeyCheck: { ...r, last4: key.slice(-4), at: Date.now() } });
  return r;
}

// { text, cls } for the saved key in the given mode. cls: good | warn | bad | muted
export async function keyStatus(key, mode, env, where = 'in Settings → Analyzer') {
  const { apiKeyCheck: chk } = await chrome.storage.local.get('apiKeyCheck');
  key = String(key || '').trim();
  if (mode !== 'anthropic') {
    const note = key ? ` (an API key ${mask(key)} is saved for Claude API mode)` : '';
    return { text: `${mode === 'bridge' ? 'Debug mode – Claude Code answers through the bridge' : 'No AI mode'}; no API key is used${note}.`, cls: 'muted' };
  }
  if (!key) return { text: `⚠ No API key saved – enter it ${where} and press Save key. Start will not run without it.`, cls: 'bad' };
  const from = key === env.ANTHROPIC_API_KEY ? 'from .env' : 'saved';
  const checked = chk && chk.last4 === key.slice(-4) ? chk : null;
  const when = checked && new Date(checked.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (checked?.ok === false) return { text: `✗ API key ${mask(key)} ${from} – rejected by the API (${when}). Enter a new one.`, cls: 'bad' };
  if (checked?.verified) return { text: `✓ API key ${mask(key)} ${from} – verified ${when}. Claude API mode is ready.`, cls: 'good' };
  return { text: `✓ API key ${mask(key)} ${from} – not verified yet (${checked?.note || 'press Save key to check it'}).`, cls: 'warn' };
}
