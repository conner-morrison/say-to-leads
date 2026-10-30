// LinkedIn's invitation modal, found through the debugger (CDP) instead of the content script.
// The content script only sees the top document: the modal was on screen but "not in the page"
// (API run 2026-10-30), so it lives in an iframe or a shadow root. DOM.getDocument with pierce=true
// returns the whole tree – open and closed shadow roots and same-process iframes – and
// DOM.getContentQuads gives viewport coordinates the CDP mouse uses directly.

const MAX_TEXT = 400;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg']);

const attrsOf = (n) => {
  const a = {};
  for (let i = 0; i + 1 < (n.attributes?.length || 0); i += 2) a[n.attributes[i]] = n.attributes[i + 1];
  return a;
};

// Flatten the pierced tree into element records with their visible text (children + shadow roots;
// an iframe's document is walked too, but its text is not the iframe element's own text).
export function flatten(root) {
  const els = [];
  let frames = 0;
  let shadows = 0;
  const visit = (n, ancestors) => {
    if (n.nodeType === 3) return n.nodeValue || '';
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return '';
    let rec = null;
    if (n.nodeType === 1) {
      rec = { id: n.backendNodeId, name: n.nodeName.toUpperCase(), attrs: attrsOf(n), text: '', ancestors };
      els.push(rec);
    }
    const kids = rec ? [...ancestors, rec] : ancestors;
    let text = '';
    if (!rec || !SKIP.has(n.nodeName)) {
      for (const sr of n.shadowRoots || []) {
        shadows++;
        text += ' ' + visit(sr, kids);
      }
      for (const c of n.children || []) text += (c.nodeType === 1 ? ' ' : '') + visit(c, kids);
    }
    if (n.contentDocument) {
      frames++;
      visit(n.contentDocument, kids);
    }
    if (rec) rec.text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    return text.length > MAX_TEXT * 2 ? text.slice(0, MAX_TEXT * 2) : text;
  };
  visit(root, []);
  return { els, frames, shadows };
}

const label = (e) => (e.text || e.attrs['aria-label'] || e.attrs.title || e.attrs.value || '').replace(/\s+/g, ' ').trim();
const isDialog = (e) =>
  /^(dialog|alertdialog)$/.test(e.attrs.role || '') || /\bartdeco-modal\b/.test(e.attrs.class || '') || (e.name === 'DIALOG' && 'open' in e.attrs);
const isClickable = (e) => ['BUTTON', 'A'].includes(e.name) || /^(button|menuitem)$/.test(e.attrs.role || '');
const isField = (e) => e.name === 'TEXTAREA' || e.attrs.contenteditable === 'true' || e.attrs.contenteditable === '' || e.attrs.role === 'textbox';
const isDisabled = (e) => 'disabled' in e.attrs || e.attrs['aria-disabled'] === 'true';
const inside = (e, d) => e.ancestors.includes(d);

export const isAddNote = (e) => /add a note/i.test(label(e)) && !/without/i.test(label(e));
export const isSend = (e) => /^send( now| invitation)?$/i.test(label(e));

export class CdpDom {
  constructor(backend) {
    this.backend = backend;
  }

  async box(id) {
    try {
      const { quads } = await this.backend.send('DOM.getContentQuads', { backendNodeId: id });
      const q = quads?.[0];
      if (!q) return null;
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      return b[2] - b[0] >= 2 && b[3] - b[1] >= 2 ? b : null; // no layout / collapsed = not shown
    } catch {
      return null;
    }
  }

  async viewport() {
    const m = await this.backend.send('Page.getLayoutMetrics');
    const v = m.cssVisualViewport || m.layoutViewport;
    return { w: v.clientWidth, h: v.clientHeight };
  }

  // Text in a field (textarea value or contenteditable text).
  async fieldText(id) {
    const { object } = await this.backend.send('DOM.resolveNode', { backendNodeId: id });
    const r = await this.backend.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.value != null ? this.value : this.innerText || ""; }',
      returnByValue: true,
    });
    await this.backend.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    return String(r.result?.value ?? '');
  }

  // What a click at viewport point (x, y) would hit: the label of the clickable (or field) under it,
  // through iframes and shadow roots. '' when it is plain page content.
  async labelAt(x, y) {
    const { backendNodeId } = await this.backend.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), ignorePointerEventsNone: true });
    const { object } = await this.backend.send('DOM.resolveNode', { backendNodeId });
    const r = await this.backend.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        const el = this.nodeType === 1 ? this : this.parentElement;
        const c = el && el.closest('button, a, [role="button"], [role="menuitem"], textarea, input, [contenteditable="true"]');
        if (!c) return '';
        const t = (c.innerText || c.getAttribute('aria-label') || c.getAttribute('placeholder') || c.title || '').replace(/\\s+/g, ' ').trim();
        return (c.tagName === 'TEXTAREA' || c.isContentEditable ? 'text box ' : '') + t.slice(0, 60);
      }`,
      returnByValue: true,
    });
    await this.backend.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    return String(r.result?.value ?? '');
  }

  // step: 'add_note' | 'field' | 'send' → { ok, state, box, inView, length, counter, seen, how }
  async invite(step) {
    await this.backend.send('DOM.enable').catch(() => {});
    const { root } = await this.backend.send('DOM.getDocument', { depth: -1, pierce: true });
    const { els, frames, shadows } = flatten(root);
    const vp = await this.viewport();
    const shownBox = async (e) => (await this.box(e.id)) || null;

    // The visible dialog, preferring one about an invitation (the last one = the topmost).
    const dialogs = [];
    for (const e of els) if (isDialog(e) && (await shownBox(e))) dialogs.push(e);
    const d = [...dialogs].reverse().find((x) => /invitation|add a note/i.test(x.text)) || dialogs[dialogs.length - 1];
    if (!d) {
      const seen = [`${dialogs.length} dialogs`, `${frames} iframes`, `${shadows} shadow roots`];
      return { ok: true, state: 'no_dialog', seen, how: 'cdp' };
    }
    const counter = d.text.match(/(?<!\d)\d{1,3}\s*\/\s*\d{2,4}(?!\d)/)?.[0] || null;
    const btns = [];
    for (const e of els) if (inside(e, d) && isClickable(e)) {
      const b = await shownBox(e);
      if (b) btns.push({ e, b });
    }
    const seen = btns.map(({ e }) => label(e)).filter(Boolean).slice(0, 12);
    const out = (state, e, b, extra = {}) => ({
      ok: true, state, box: b, how: 'cdp', counter, seen,
      inView: b ? b[0] >= 0 && b[1] >= 0 && b[2] <= vp.w + 1 && b[3] <= vp.h + 1 : false,
      ...extra,
    });

    if (step === 'add_note') {
      // Outermost match only: a <span>Add a note</span> inside the button is not a second button.
      const hits = btns.filter(({ e }) => isAddNote(e));
      const hit = hits.find((h) => !hits.some((o) => o !== h && inside(h.e, o.e)));
      return hit ? out('found', hit.e, hit.b) : out('none', null, null);
    }
    if (step === 'send') {
      const hit = btns.find(({ e }) => isSend(e));
      return hit ? out(isDisabled(hit.e) ? 'disabled' : 'found', hit.e, hit.b) : out('none', null, null);
    }
    // field
    for (const e of els) if (inside(e, d) && isField(e)) {
      const b = await shownBox(e);
      if (!b) continue;
      const text = await this.fieldText(e.id).catch(() => '');
      return out('found', e, b, { length: text.length });
    }
    return out('none', null, null);
  }
}
