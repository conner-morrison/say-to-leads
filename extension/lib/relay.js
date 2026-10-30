// Registration with the relay server (Settings → Registration) and the URL feed it sends.
//
// Protocol (worker side of the relay, base = the workspace URL, e.g. https://host/upwork):
//   POST {base}/enrol {name, label}       → a ticket (and a fingerprint the admin compares)
//   GET  {base}/enrol/{ticket}?wait=25     → held open until a person approves; then the worker id.
//                                            404 = declined or expired.
//   GET  {base}/messages?wait=25           → with "Authorization: Bearer <id>": messages from the
//                                            channels this worker belongs to. 401 = id unknown.
//   POST {base}/ack {channel, seq}         → moves this worker's cursor past what it handled.
// The server cannot call the extension, so every answer arrives on a long poll the extension holds open.
//
// Status: none → pending (asked, waiting for approval) → registered (has an id, no channel yet)
//         → ready (a channel is allocated; URLs can arrive). rejected = the request was declined.

import { log } from './logger.js';

export const DEFAULT_RELAY_URL = 'https://relay-production-7643.up.railway.app/upwork';

const KEY = 'relay';
const WAIT_SEC = 25;
const LABEL = 'Say To Leads (Chrome extension)';

export const EMPTY = { status: 'none', url: '', name: '', ticket: null, fingerprint: null, workerId: null, channels: [], error: null };

export class RelayClient {
  constructor({ onChange, onTrigger }) {
    this.onChange = onChange;
    this.onTrigger = onTrigger;
    this.s = { ...EMPTY };
    this.gen = 0; // bumped to end the current poll loop
    this.consume = true; // false = don't watch for triggers (URL-list mode, or a run is busy with its queue)
    this.abort = null;
  }

  async load() {
    const { [KEY]: saved } = await chrome.storage.local.get(KEY);
    this.s = { ...EMPTY, ...saved };
    this.onChange(this.view());
    this.ensureLoop();
  }

  view() {
    const { status, url, name, fingerprint, workerId, channels, error } = this.s;
    return { status, url, name, fingerprint, workerId, channels, error };
  }

  async save(patch) {
    Object.assign(this.s, patch);
    await chrome.storage.local.set({ [KEY]: this.s });
    this.onChange(this.view());
  }

  get base() {
    return this.s.url.replace(/\/+$/, '');
  }

  // Ask to join under a name. Replaces any earlier registration of this extension.
  async register(url, name) {
    url = String(url || '').trim();
    name = String(name || '').trim();
    if (!name) throw new Error('Give this extension a name.');
    if (name.length > 64) throw new Error('The name can be at most 64 characters.');
    if (!/^https?:\/\/[^/]+/i.test(url)) throw new Error('The server URL must start with https://');
    this.stopLoop();
    await this.save({ ...EMPTY, url, name });
    const res = await fetch(`${this.base}/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, label: LABEL }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => {
      throw new Error(`Could not reach ${this.base} (${e.message}). Check the URL, the internet connection, and the extension's site access.`);
    });
    const body = await readJson(res);
    log.debug('relay enrol answer', body);
    if (!res.ok) throw new Error(`Server refused the registration: ${errText(body, res)}`);
    const ticket = body.ticket ?? body.ref;
    if (!ticket) throw new Error(`Server answered without a ticket: ${JSON.stringify(body).slice(0, 200)}`);
    await this.save({ status: 'pending', ticket, fingerprint: body.fingerprint ?? null });
    log.info(`Registration sent as "${name}" – waiting for the server to approve it${body.fingerprint ? ` (fingerprint ${body.fingerprint})` : ''}`);
    this.ensureLoop();
  }

  async forget() {
    this.stopLoop();
    await this.save({ ...EMPTY, url: this.s.url, name: this.s.name });
    log.info('Registration removed from this extension');
  }

  stopLoop() {
    this.gen++;
    this.abort?.abort();
    this.abort = null;
  }

  setConsume(on) {
    if (this.consume === on) return;
    this.consume = on;
    if (on) this.ensureLoop();
    else if (this.s.status !== 'pending') this.stopLoop(); // leads stay on the server until fetched
  }

  get polling() {
    const st = this.s.status;
    return st === 'pending' || (this.consume && (st === 'registered' || st === 'ready'));
  }

  // One poll loop at a time; it ends by itself when there is nothing to wait for.
  ensureLoop() {
    if (this.abort || !this.polling) return;
    const gen = ++this.gen;
    this.abort = new AbortController();
    this.loop(gen, this.abort.signal).finally(() => {
      if (gen === this.gen) this.abort = null;
    });
  }

  async loop(gen, signal) {
    let backoff = 2000;
    while (gen === this.gen && !signal.aborted) {
      const t0 = Date.now();
      let quiet = false;
      try {
        if (!this.polling) return;
        if (this.s.status === 'pending') quiet = await this.checkTicket(signal);
        else quiet = await this.pollMessages(signal);
        if (this.s.error) await this.save({ error: null });
        backoff = 2000;
      } catch (e) {
        if (signal.aborted) return;
        log.warn(`Relay: ${e.message}`);
        await this.save({ error: e.message });
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      // A server that answers at once must not be asked in a tight loop – also when the answer has
      // messages the engine did not take (e.g. a lead that stays unacked while the run is blocked).
      if (Date.now() - t0 < 3000) await sleep(quiet ? 5000 : 3000, signal);
    }
  }

  // Returns true when nothing changed (still waiting).
  async checkTicket(signal) {
    const res = await fetch(`${this.base}/enrol/${encodeURIComponent(this.s.ticket)}?wait=${WAIT_SEC}`, {
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout((WAIT_SEC + 15) * 1000)]),
    });
    const body = await readJson(res);
    if (res.status === 404) {
      await this.save({ status: 'rejected', ticket: null, error: errText(body, res) });
      log.warn(`Registration was declined or expired: ${errText(body, res)}`);
      return true;
    }
    if (!res.ok) throw new Error(`approval check failed: ${errText(body, res)}`);
    const id = body.worker_id ?? body.id;
    if (!id) return true; // still waiting for a person
    log.debug('relay approval answer', body);
    await this.save({ status: 'registered', workerId: id, ticket: null, name: body.name || this.s.name });
    log.info(`Registered with the server as "${this.s.name}" – waiting for a channel`);
    return false;
  }

  // Watching: hold a question open until anything arrives (a lead, a "new leads" trigger, a notice).
  // It only signals; the engine then fetches, marks and acknowledges the leads itself.
  async pollMessages(signal) {
    const { messages, notices } = await this.get({ wait: WAIT_SEC, limit: 1, signal });
    if (!messages.length && !notices.length) return true;
    await this.onTrigger();
    return false;
  }

  // Messages above this worker's cursors (oldest first). Reading does not move the cursors – ack does.
  async get({ wait = 0, limit = 10, signal } = {}) {
    const timeout = AbortSignal.timeout((wait + 15) * 1000);
    const res = await fetch(`${this.base}/messages?wait=${wait}&limit=${limit}`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${this.s.workerId}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = await readJson(res);
    if (res.status === 401) {
      await this.save({ status: 'none', workerId: null, channels: [], error: 'The server no longer knows this extension – register again.' });
      log.warn('Relay: the server no longer knows this id – registration cleared');
      throw new Error('the server no longer knows this extension – register again');
    }
    if (!res.ok) throw new Error(`message fetch failed: ${errText(body, res)}`);

    const messages = Array.isArray(body) ? body : body.messages || body.items || [];
    const channels = new Set(channelNames(body.channels ?? body.memberships));
    for (const m of messages) if (m?.channel) channels.add(m.channel);
    // The server tells a worker about changes (e.g. being added to a channel) as one-off notices.
    // Their shape is not documented, so log them and take any channel they name.
    const notices = Array.isArray(body.notices) ? body.notices : [];
    for (const n of notices) {
      log.info(`Server notice: ${typeof n === 'string' ? n : JSON.stringify(n)}`);
      for (const c of noticeChannels(n)) channels.add(c);
    }
    // Only a listed channel (or a message from one) proves a channel; never drop back on silence.
    if (channels.size) {
      const list = [...new Set([...this.s.channels, ...channels])].sort();
      if (this.s.status !== 'ready') log.info(`Server allocated channel ${list.map((c) => '#' + c).join(', ')}`);
      if (this.s.status !== 'ready' || list.join() !== this.s.channels.join()) await this.save({ status: 'ready', channels: list });
    } else if (Array.isArray(body.channels) && this.s.status === 'ready') {
      await this.save({ status: 'registered', channels: [] });
      log.warn('Relay: this extension is no longer in any channel');
    }
    if (messages.length) log.debug(`relay: ${messages.length} message(s)`, messages.slice(0, 3));
    return { messages, notices };
  }

  // Move this worker's cursor in each channel past the given seq, so the next fetch starts right after it.
  async ack(lastByChannel) {
    for (const [channel, seq] of Object.entries(lastByChannel)) {
      const r = await fetch(`${this.base}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.s.workerId}` },
        body: JSON.stringify({ channel, seq }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`ack #${channel}@${seq} failed: ${errText(await readJson(r), r)}`);
    }
  }

  // Post into a channel. `id` makes a retry harmless (the server keeps one message per id).
  async publish(channel, body, id) {
    const r = await fetch(`${this.base}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.s.workerId}` },
      body: JSON.stringify({ channel, body, id }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`publish to #${channel} failed: ${errText(await readJson(r), r)}`);
  }
}

// Channel lists may come as names, objects, or a {name: cursor} map.
function channelNames(c) {
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.name || x?.channel)).filter(Boolean);
  if (c && typeof c === 'object') return Object.keys(c);
  return [];
}

// Channel names in a notice: a channel/channels field, or "#name" in its text.
function noticeChannels(n) {
  const out = [];
  if (n && typeof n === 'object') {
    out.push(...channelNames(n.channels));
    if (typeof n.channel === 'string') out.push(n.channel);
  }
  const text = typeof n === 'string' ? n : JSON.stringify(n);
  if (/channel|added|joined|member/i.test(text)) for (const m of text.matchAll(/#([A-Za-z0-9][\w.-]*)/g)) out.push(m[1]);
  return out;
}

// Leads in one server message: {url, name} items. A body may hold one lead, a list of leads
// (any array of objects with a URL), or just text with a URL in it.
const NAME_KEYS = ['name', 'full_name', 'fullName', 'lead_name', 'leadName', 'person', 'contact', 'profile_name', 'profileName'];
const JOB_ID_KEYS = ['jobId', 'job_id', 'job', 'proposalId', 'proposal_id', 'lead_id', 'leadId', 'id'];

export function leadsIn(m) {
  const b = m?.body;
  const base = { channel: m.channel, seq: m.seq, job: m.job || null };
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    for (const v of Object.values(b)) {
      if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && findUrls(x).length)) {
        return v.map((x, i) => oneLead(x, { ...base, part: i })).filter(Boolean);
      }
    }
  }
  if (Array.isArray(b)) return b.map((x, i) => oneLead(x, { ...base, part: i })).filter(Boolean);
  const one = oneLead(b, { ...base, part: 0 });
  return one ? [one] : [];
}

function oneLead(x, base) {
  const urls = findUrls(x);
  const url = urls.find((u) => /linkedin\.com\/in\//i.test(u)) || urls[0];
  if (!url) return null;
  let name = null;
  let job = base.job;
  if (x && typeof x === 'object') {
    const src = x.lead && typeof x.lead === 'object' ? { ...x, ...x.lead } : x;
    name = NAME_KEYS.map((k) => src[k]).find((v) => typeof v === 'string' && v.trim()) || null;
    if (!name && (src.first_name || src.firstName)) name = [src.first_name || src.firstName, src.last_name || src.lastName].filter(Boolean).join(' ');
    job ??= JOB_ID_KEYS.map((k) => src[k]).find((v) => (typeof v === 'string' && v.trim()) || typeof v === 'number') ?? null;
  }
  return { url, name: name ? String(name).trim() : null, job: job == null ? null : String(job), channel: base.channel, seq: base.seq, key: `${base.channel}:${base.seq}:${base.part}` };
}

// Every http(s) URL in a message body, whatever shape it has: a string, {url}, {urls: [...]}, nested.
export function findUrls(body, out = []) {
  if (typeof body === 'string') {
    for (const m of body.matchAll(/https?:\/\/[^\s"'<>,]+/gi)) out.push(m[0].replace(/[).;\]]+$/, ''));
  } else if (Array.isArray(body)) body.forEach((b) => findUrls(b, out));
  else if (body && typeof body === 'object') Object.values(body).forEach((v) => findUrls(v, out));
  return out;
}

async function readJson(res) {
  try {
    return (await res.json()) ?? {};
  } catch {
    return {};
  }
}

function errText(body, res) {
  if (typeof body?.message === 'string') return body.message;
  if (typeof body?.detail === 'string') return body.detail;
  if (Array.isArray(body?.detail)) return body.detail.map((d) => d.msg).join('; ');
  return `${res.status} ${res.statusText}`;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
