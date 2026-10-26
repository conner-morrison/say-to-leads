// Telegram bot: outgoing notifications (text / photo) and optional remote commands.

import { log } from './logger.js';

export class Telegram {
  constructor(cfg) {
    this.cfg = cfg;
    this.offset = 0;
    this.polling = false;
    this.recent = new Map(); // text -> ts, de-duplicates bursts
  }

  get ready() {
    return this.cfg.enabled && this.cfg.botToken && this.cfg.chatId;
  }

  api(method) {
    return `https://api.telegram.org/bot${this.cfg.botToken}/${method}`;
  }

  async send(text, photoBlob = null, { dedupe = true } = {}) {
    if (!this.ready) return false;
    const now = Date.now();
    for (const [k, t] of this.recent) if (now - t > 60_000) this.recent.delete(k);
    if (dedupe && this.recent.has(text)) return false;
    this.recent.set(text, now);
    try {
      let res;
      if (photoBlob) {
        const fd = new FormData();
        fd.append('chat_id', this.cfg.chatId);
        fd.append('caption', text.slice(0, 1000));
        fd.append('photo', photoBlob, 'screen.jpg');
        res = await fetch(this.api('sendPhoto'), { method: 'POST', body: fd });
      } else {
        res = await fetch(this.api('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.cfg.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        });
      }
      const body = await res.json();
      if (!body.ok) throw new Error(body.description);
      return true;
    } catch (e) {
      log.warn('Telegram send failed', e.message);
      return false;
    }
  }

  // Long-polls getUpdates; only messages from the configured chat are accepted.
  async startPolling(onCommand) {
    if (!this.ready || !this.cfg.commandsEnabled || this.polling) return;
    this.polling = true;
    this.pollAbort = new AbortController();
    log.info('Telegram command polling started');
    while (this.polling) {
      try {
        const res = await fetch(this.api(`getUpdates?timeout=25&offset=${this.offset}`), { signal: this.pollAbort.signal });
        const body = await res.json();
        for (const u of body.result || []) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || String(m.chat.id) !== String(this.cfg.chatId) || !m.text) continue;
          const cmd = m.text.trim().split(/\s+/)[0].replace(/@.*/, '').toLowerCase();
          onCommand(cmd, m.text);
        }
      } catch (e) {
        if (!this.polling) break;
        log.debug('Telegram poll error', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stopPolling() {
    this.polling = false;
    this.pollAbort?.abort();
  }
}
