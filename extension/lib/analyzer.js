// Analyzer providers. All return the same sanitized result shape (see schema.js).
//  - bridge:    debug mode. POSTs to the local bridge; Claude Code reads the request and answers.
//  - anthropic: production. Calls the Claude Messages API directly with an API key.
//  - none:      watch-only (notifications → Telegram), no AI.

import { RESULT_SCHEMA, SYSTEM_PROMPT, sanitizeResult } from './schema.js';

export function buildUserText(req) {
  const ev = req.events.length
    ? req.events.map((e) => `- [${e.kind}] ${e.text}`).join('\n')
    : '(none)';
  const hist = req.history.length
    ? req.history.map((h) => `- ${new Date(h.t).toLocaleTimeString()} ${h.summary} → ${h.actions.join(', ') || 'no actions'}`).join('\n')
    : '(none)';
  const last = req.lastActions.length
    ? req.lastActions.map((a) => `- ${a.type}: ${a.ok ? 'ok' : 'FAILED ' + a.error}`).join('\n')
    : '(none)';
  const f = req.feed;
  const feed = !f
    ? '(no feed – working on the linked tab as it is)'
    : f.index < 0
      ? `not opened yet (${f.total} pages) – "next" opens page 1: ${f.url}`
      : `page ${f.index + 1} of ${f.total} – ${f.url}${f.index + 1 === f.total ? ' (last)' : ''}`;
  const first = req.firstMessages?.length
    ? `\n\nSAVED FIRST MESSAGES (use only when the job asks for one):\n${req.firstMessages.map((m, i) => `${i + 1}. ${m.replace(/\n/g, '\n   ')}`).join('\n')}`
    : '';
  const send = req.sendMode === 'auto'
    ? 'auto – after typing a message, click Send yourself.'
    : 'review – after typing a message, do NOT click Send: notify the human and pause; they send it and resume.';
  const ib = req.inbox;
  const inbox = !ib
    ? ''
    : `\n\nINBOX CHECK DUE: look at the Messaging panel (docked on the right). Besides your job actions, add
"inbox": {"top": first real conversation's name (skip "Sponsored" ads), "unread": names shown blue/bold, "accepted": [...]}.
Previous top: ${ib.lastTop ? `"${ib.lastTop}" (${new Date(ib.lastAt).toLocaleString()})` : '(none – first check, accepted = [])'}.
Conversations listed above the previous top that are NOT unread are people who accepted the invitation
(put them in accepted). If the panel is collapsed, click its header to open it and leave "inbox" out this turn.`;
  return `FEED: ${feed}${first}\n\nSEND MODE: ${send}${inbox}\n\nPAGE: ${req.page.title}\nURL: ${req.page.url}\nLOCAL TIME: ${new Date(req.created).toString()}\n\nNEW PAGE EVENTS:\n${ev}\n\nRESULT OF YOUR LAST ACTIONS:\n${last}\n\nRECENT HISTORY:\n${hist}`;
}

export async function analyze(req, settings, signal) {
  const a = settings.analyzer;
  if (a.mode === 'none') return { summary: '(watch-only mode)', actions: [], next_check_sec: null };
  if (a.mode === 'bridge') return sanitizeResult(await viaBridge(req, a, signal));
  if (a.mode === 'anthropic') return sanitizeResult(await viaAnthropic(req, a, signal));
  throw new Error(`unknown analyzer mode ${a.mode}`);
}

async function viaBridge(req, a, signal) {
  const timeout = AbortSignal.timeout((a.bridgeTimeoutSec + 15) * 1000);
  const res = await fetch(`${a.bridgeUrl.replace(/\/$/, '')}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...req, system: SYSTEM_PROMPT, prompt: buildUserText(req), timeoutSec: a.bridgeTimeoutSec }),
    signal: AbortSignal.any([signal, timeout]),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`bridge: ${body.error || res.status}`);
  return body.result;
}

async function viaAnthropic(req, a, signal) {
  if (!a.apiKey) throw new Error('No API key set (Settings → Analyzer)');
  // Server-side refusal fallback: a declined request is retried on a suitable model. Haiku has none.
  const fallback = !a.model.startsWith('claude-haiku');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': a.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(fallback && { 'anthropic-beta': 'server-side-fallback-2026-07-01' }),
    },
    body: JSON.stringify({
      model: a.model,
      max_tokens: 16000,
      ...(fallback && { fallbacks: 'default' }),
      system: SYSTEM_PROMPT,
      output_config: { effort: a.effort, format: { type: 'json_schema', schema: RESULT_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: req.image.mime, data: req.image.base64 } },
            { type: 'text', text: buildUserText(req) },
          ],
        },
      ],
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
  });
  const msg = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${msg?.error?.message || 'error'}`);
  if (msg.stop_reason === 'refusal') throw new Error(`API refusal: ${msg.stop_details?.explanation || ''}`);
  if (msg.stop_reason === 'max_tokens') throw new Error('API output truncated (max_tokens)');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

export async function bridgeHealth(url) {
  const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}
