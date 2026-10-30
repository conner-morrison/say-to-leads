// Isolated-world content script, injected on Start into the linked tab.
// Jobs: report viewport/selector geometry, watch for new notifications/messages,
// execute DOM-driver input, draw the debug cursor.
(() => {
  // A copy left over from before an extension reload is cut off from the extension but still holds
  // its timer; replace it rather than keeping it (the old guard kept the dead copy).
  window.__stlTeardown?.();

  let cfg = { titleBadge: true, notificationApi: true, selectors: [], showCursor: false };

  // ---------- event watching ----------

  const emit = (kind, text) =>
    chrome.runtime
      .sendMessage({ type: 'page-event', event: { kind, text: String(text).slice(0, 300), t: Date.now(), url: location.href } })
      .catch(() => {});

  const titleCount = (t) => {
    const m = String(t).match(/\((\d+)\+?\)/);
    return m ? Number(m[1]) : 0;
  };
  let lastTitle = titleCount(document.title);
  const selCounts = new Map();

  function watchTick() {
    if (cfg.titleBadge) {
      const n = titleCount(document.title);
      if (n > lastTitle) emit('title', document.title);
      lastTitle = n;
    }
    for (const sel of cfg.selectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      const prev = selCounts.has(sel) ? selCounts.get(sel) : els.length;
      if (els.length > prev) emit('selector', `${sel}: ${(els[els.length - 1].innerText || '').trim()}`);
      selCounts.set(sel, els.length);
    }
  }
  const watchTimer = setInterval(watchTick, 2000); // polling is cheaper than a page-wide MutationObserver on old CPUs

  // Forwarded from content-main.js (page world), which wraps window.Notification.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__stl !== true) return;
    if (cfg.notificationApi && e.data.kind === 'notification') emit('notification', `${e.data.title}${e.data.body ? ' — ' + e.data.body : ''}`);
  });

  // ---------- debug cursor ----------

  let dot = null;
  function drawCursor(x, y, down) {
    if (!cfg.showCursor) return;
    if (!dot) {
      dot = document.createElement('div');
      dot.style.cssText =
        'position:fixed;z-index:2147483647;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;' +
        'pointer-events:none;border:2px solid #fff;box-shadow:0 0 0 1px #0006;transition:background .1s';
      document.documentElement.appendChild(dot);
    }
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    dot.style.background = down ? '#e53935' : '#1e88e5';
  }

  // ---------- DOM driver ----------

  function deepFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el || document.body;
  }
  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el || document.body;
  }
  const BTN = { left: 0, middle: 1, right: 2 };
  let hoverEl = null;

  function fireMouse(type, x, y, extra = {}) {
    const el = deepFromPoint(x, y);
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, ...extra };
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init }));
    return el;
  }

  const isField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/i.test(el.type)));

  function insertText(ch) {
    const el = deepActive();
    if (isField(el)) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      el.setRangeText(ch, s, e, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, ch);
    }
  }
  function deleteBackward() {
    const el = deepActive();
    if (isField(el)) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      if (s === e && s > 0) el.setRangeText('', s - 1, s, 'end');
      else el.setRangeText('', s, e, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    } else if (el.isContentEditable) {
      document.execCommand('delete');
    }
  }
  function fireKey(type, spec, bits) {
    const el = deepActive();
    return el.dispatchEvent(
      new KeyboardEvent(type, {
        key: spec.key,
        code: spec.code,
        keyCode: spec.vk,
        which: spec.vk,
        altKey: !!(bits & 1),
        ctrlKey: !!(bits & 2),
        metaKey: !!(bits & 4),
        shiftKey: !!(bits & 8),
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  }
  function scrollableAt(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function dom(m) {
    const { op, x, y } = m;
    switch (op) {
      case 'move': {
        const el = fireMouse('pointermove', x, y);
        fireMouse('mousemove', x, y);
        if (el !== hoverEl) {
          hoverEl?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
          hoverEl = el;
        }
        return;
      }
      case 'down': {
        const button = BTN[m.button] ?? 0;
        const el = fireMouse('pointerdown', x, y, { button, buttons: 1, detail: m.clickCount });
        fireMouse('mousedown', x, y, { button, buttons: 1, detail: m.clickCount });
        const f = el.closest?.('input,textarea,select,button,a[href],[tabindex],[contenteditable=""],[contenteditable="true"]');
        f?.focus?.({ preventScroll: true });
        return;
      }
      case 'up': {
        const button = BTN[m.button] ?? 0;
        fireMouse('pointerup', x, y, { button, detail: m.clickCount });
        fireMouse('mouseup', x, y, { button, detail: m.clickCount });
        if (button === 2) fireMouse('contextmenu', x, y, { button });
        else {
          fireMouse('click', x, y, { button, detail: m.clickCount });
          if (m.clickCount === 2) fireMouse('dblclick', x, y, { button, detail: 2 });
        }
        return;
      }
      case 'wheel': {
        const el = deepFromPoint(x, y);
        const ok = el.dispatchEvent(new WheelEvent('wheel', { deltaY: m.dy, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
        if (ok) scrollableAt(el).scrollBy({ top: m.dy, behavior: 'instant' });
        return;
      }
      case 'keydown': {
        const ok = fireKey('keydown', m.spec, m.bits);
        if (!ok) return;
        if (m.spec.key === 'Backspace') deleteBackward();
        else if ((m.bits & 6) && m.spec.key.toLowerCase() === 'a') {
          const el = deepActive();
          if (isField(el)) el.select();
          else document.execCommand('selectAll');
        } else if (m.spec.key === 'Enter' && (m.bits & 8)) insertText('\n');
        return;
      }
      case 'keyup':
        fireKey('keyup', m.spec, m.bits);
        return;
      case 'char': {
        const spec = { key: m.ch, code: '', vk: m.ch.toUpperCase().charCodeAt(0) };
        if (fireKey('keydown', spec, 0)) {
          fireKey('keypress', spec, 0);
          insertText(m.ch);
        }
        fireKey('keyup', spec, 0);
        return;
      }
    }
  }

  // ---------- LinkedIn profile: Connect ----------
  // Finds the profile header's Connect button, or the More (…) button whose menu holds it, in the DOM,
  // so the click does not depend on where the model thinks it is on the screenshot (screen size,
  // Windows scaling and zoom differ per PC). Icons are checked first: they don't change with the UI language.

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [aria-haspopup], [aria-expanded]';
  const MENU = '[role="menu"], [role="listbox"], [data-popper-placement], .artdeco-dropdown__content--is-open';
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const aria = (el) => el.getAttribute('aria-label') || el.getAttribute('title') || '';
  const icons = (el) =>
    [...el.querySelectorAll('[data-test-icon], li-icon, use, svg')]
      .map((i) => [i.getAttribute('data-test-icon'), i.getAttribute('type'), i.getAttribute('href'), i.getAttribute('xlink:href'), i.id, i.getAttribute('aria-label')].filter(Boolean).join(' '))
      .join(' ');
  function shown(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && !(Number(s.opacity || 1) < 0.05);
  }
  // The bar pinned to the top after scrolling repeats the buttons; only the header card counts.
  // (Only a bar – a sticky column holding the whole card is fine.)
  function inBar(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (/fixed|sticky/.test(getComputedStyle(n).position) && n.getBoundingClientRect().height < 160) return true;
    }
    return false;
  }
  const isPending = (el) => /\bpending\b/i.test(`${aria(el)} ${textOf(el)}`) || /clock/i.test(icons(el));
  const isConnect = (el) =>
    !isPending(el) &&
    (/(^|[\s#/-])connect([\s-]|$)/i.test(icons(el)) || /\bto connect\b/i.test(aria(el)) || /^\+?\s*connect$/i.test(textOf(el)));
  // "More" / "…": by name, by icon, as a popup trigger (any language), or as an unlabeled icon button.
  const isMore = (el) =>
    /overflow|ellipsis|more-horizontal|three-dots|kebab/i.test(icons(el)) || /\bmore\b|more actions/i.test(aria(el)) ||
    /^(more|…|⋯|···|\.\.\.)$/i.test(textOf(el));
  const isPopup = (el) =>
    (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') || el.hasAttribute('aria-expanded') ||
    /dropdown__trigger/.test(el.className?.baseVal ?? el.className ?? '');
  // Header actions that are never the "…" (Save in Sales Navigator also opens a popup).
  const isKnownAction = (el) => /\bmessage\b|\bfollow|sales navigator|\bsave\b|\bconnect\b|\bpending\b/i.test(`${aria(el)} ${textOf(el)}`);
  const iconOnly = (el) => !textOf(el) && !!el.querySelector('svg, li-icon, img');
  const brief = (el) => {
    const name = (aria(el) || textOf(el)).slice(0, 40);
    if (name) return name;
    const icon = icons(el).split(/[\s#/]+/).find(Boolean);
    return `[${isPopup(el) ? 'popup ' : ''}icon${icon ? ' ' + icon.slice(0, 30) : ''}]`;
  };

  // Buttons of the header card around the profile name: inside the card (or, if none is found, in the
  // name's column) and from a little above the name (a "…" may sit in the card's top corner) to the
  // action row under it. Side columns, menus and the top bar are left out, so another person's Connect
  // ("People you may know", the right column) can never be picked.
  const usable = (b) => shown(b) && !inBar(b) && !b.closest(`aside, ${MENU}, .artdeco-dropdown__content`) && !b.parentElement?.closest(CLICKABLE);

  function headerButtons() {
    const h1 = [...document.querySelectorAll('main h1, h1')].find((h) => shown(h) && !inBar(h));
    if (!h1) return rowFromMessage();
    const nr = h1.getBoundingClientRect();
    let card = h1.closest('section, .artdeco-card, [class*="top-card"], [class*="topcard"], [data-view-name*="top-card"]');
    const cw = card?.getBoundingClientRect().width ?? 0;
    if (cw > innerWidth * 0.8 || cw < nr.width) card = null; // a page-wide wrapper (or a box without layout), not the card
    const cr = card?.getBoundingClientRect();
    const inside = (r) =>
      cr ? r.left >= cr.left - 2 && r.right <= cr.right + 2 : r.left > nr.left - 80 && r.left < nr.left + 700 && r.left < innerWidth * 0.66;
    return [...(card || document).querySelectorAll(CLICKABLE)].filter((b) => {
      if (!usable(b)) return false; // (only the outer button counts, not its inner parts)
      const r = b.getBoundingClientRect();
      return r.top > nr.top - 260 && r.top < nr.top + 450 && inside(r);
    });
  }

  // Without a name heading: the top-most Message / Save in Sales Navigator button in the main column
  // anchors the row, and the row is what lines up with it.
  function rowFromMessage() {
    const all = [...document.querySelectorAll(CLICKABLE)].filter(usable);
    const anchor = all
      .filter((b) => /^(message|save in sales navigator|\+?\s*follow)$/i.test(textOf(b)) && b.getBoundingClientRect().left < innerWidth * 0.66)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    return anchor ? rowMates(anchor, all) : [];
  }

  // Everything on the anchor's line, to both sides: the anchor is not always the row's first button –
  // Owen Robertson's (2026-10-30) row was Connect · Save in Sales Navigator · …, and a row cut at the
  // anchor's left edge lost the blue Connect, so the run opened the … menu (no Connect there) and skipped him.
  // The right column (another person's Connect) starts past ~2/3 of the window and stays out.
  function rowMates(anchor, all) {
    const ar = anchor.getBoundingClientRect();
    const cy = (ar.top + ar.bottom) / 2;
    return all.filter((b) => {
      const r = b.getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - cy) < ar.height * 0.6 && r.left > ar.left - 600 && r.left < ar.left + 700 && r.left < innerWidth * 0.66;
    });
  }

  // The action row: the buttons that line up with Message / Save in Sales Navigator / Follow.
  function actionRow(btns) {
    const anchor = btns.find(isKnownAction);
    if (!anchor) return [];
    const ar = anchor.getBoundingClientRect();
    const cy = (ar.top + ar.bottom) / 2;
    return btns.filter((b) => {
      const r = b.getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - cy) < ar.height * 0.6;
    });
  }

  let moreButton = null;
  let before = new WeakSet(); // clickables on screen before the menu opened
  function openMenu() {
    const id = moreButton?.getAttribute('aria-controls');
    const candidates = [
      id && document.getElementById(id),
      moreButton?.closest('.artdeco-dropdown')?.querySelector('.artdeco-dropdown__content'),
      ...document.querySelectorAll(MENU),
    ];
    return candidates.find((c) => c && shown(c)) || null;
  }

  function place(el, extra) {
    const r = el.getBoundingClientRect();
    return { ok: true, box: [r.left, r.top, r.right, r.bottom], inView: r.top >= 0 && r.bottom <= innerHeight, ...extra };
  }

  function liConnect(step) {
    if (step === 'row') {
      const btns = headerButtons();
      // Complete the action row: the card/name search may cut off buttons beside the known ones.
      const anchor = btns.find(isKnownAction);
      if (anchor) for (const b of rowMates(anchor, [...document.querySelectorAll(CLICKABLE)].filter(usable))) if (!btns.includes(b)) btns.push(b);
      const seen = btns.map(brief).slice(0, 14);
      const pending = btns.find(isPending);
      if (pending) return place(pending, { state: 'pending', seen });
      const connect = btns.find(isConnect);
      if (connect) return place(connect, { state: 'connect', seen });
      // The "…": by name/icon; else the right end of the action row (Message · Save in Sales Navigator · …);
      // else a popup trigger or an unlabeled icon button. Message, Follow and Sales Navigator are never it.
      const last = (list) => list.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      const cands = btns.filter((b) => !isKnownAction(b));
      const named = cands.find(isMore);
      const rowEnd = !named && last(actionRow(btns).filter((b) => !isKnownAction(b) && textOf(b).length <= 3));
      const popup = !named && !rowEnd && last(cands.filter(isPopup));
      const bare = !named && !rowEnd && !popup && last(cands.filter(iconOnly));
      moreButton = named || rowEnd || popup || bare || null;
      before = new WeakSet([...document.querySelectorAll(CLICKABLE)].filter(shown));
      const how = named ? 'named' : rowEnd ? 'row-end' : popup ? 'popup trigger' : 'unlabeled icon';
      if (moreButton) return place(moreButton, { state: 'more', how, seen });
      return { ok: true, state: 'none', seen };
    }
    // step 'menu': the More/… dropdown should be open. Its items are the menu element's buttons, or
    // else whatever clickables appeared since the click.
    const menu = openMenu();
    const items = menu
      ? [...menu.querySelectorAll(CLICKABLE)].filter((b) => shown(b) && b !== moreButton)
      : [...document.querySelectorAll(CLICKABLE)].filter((b) => shown(b) && !before.has(b) && !b.closest('aside'));
    const seen = items.map(brief).slice(0, 14);
    if (!items.length) return { ok: true, state: 'closed', seen };
    const pending = items.find(isPending);
    if (pending) return place(pending, { state: 'pending', seen });
    const connect = items.find(isConnect);
    if (connect) return place(connect, { state: 'connect', seen });
    return { ok: true, state: 'none', seen };
  }

  // ---------- LinkedIn invitation modal: Add a note → note box → Send ----------
  // "Add a note" (white) sits right next to "Send without a note" (blue): a box guessed from a small
  // screenshot can hit the wrong one, which sends the invitation without the note. So the buttons are
  // found here by their labels, and "without a note" is never returned.

  // LinkedIn renders this modal inside a shadow root (e.g. #interop-outlet), which querySelectorAll
  // does not enter: search the document and every open shadow root below it.
  // Closed shadow roots too: extensions may open them with chrome.dom.openOrClosedShadowRoot.
  const shadowOf = (el) => el.shadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || null;
  function deepAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) {
      const sr = shadowOf(el);
      if (sr) out.push(...deepAll(selector, sr));
    }
    return out;
  }
  function inviteDialog() {
    const dialogs = deepAll('[role="dialog"], [role="alertdialog"], .artdeco-modal, dialog[open]').filter(shown);
    return dialogs[dialogs.length - 1] || null; // the top-most one
  }
  // What the page holds when no modal is found, so a failure says where to look.
  function dialogClues() {
    const hosts = [...document.querySelectorAll('*')].filter((el) => shadowOf(el)).map((el) => el.id ? `#${el.id}` : el.tagName.toLowerCase());
    const named = deepAll('[aria-modal="true"], [class*="modal"], [data-test-modal]').filter(shown).map((el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(/\s+/)[0] || ''}`);
    return [...hosts.slice(0, 5).map((h) => `shadow host ${h}`), ...named.slice(0, 5)];
  }
  const dialogButtons = (d) => deepAll(CLICKABLE, d).filter((b) => shown(b));
  const without = (b) => /without/i.test(`${aria(b)} ${textOf(b)}`);
  const disabled = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';

  function liInvite(step) {
    const d = inviteDialog();
    if (!d) return { ok: true, state: 'no_dialog', seen: dialogClues() };
    const btns = dialogButtons(d);
    const seen = btns.map(brief).slice(0, 10);
    const counter = (textOf(d).match(/\b\d{1,3}\s*\/\s*\d{3}\b/) || [''])[0].replace(/\s+/g, '');
    if (step === 'add_note') {
      const b = btns.find((x) => !without(x) && (/^add a note$/i.test(textOf(x)) || /\badd a note\b/i.test(aria(x))));
      return b ? place(b, { state: 'found', seen }) : { ok: true, state: 'none', seen };
    }
    if (step === 'field') {
      const f = deepAll('textarea, [contenteditable="true"], [contenteditable=""]', d)[0];
      if (!f || !shown(f)) return { ok: true, state: 'none', seen };
      const value = f.value ?? textOf(f);
      return place(f, { state: 'found', length: value.length, counter, seen });
    }
    if (step === 'send') {
      const b = btns.find((x) => !without(x) && (/^send( now| invitation)?$/i.test(textOf(x)) || /^send (now|invitation)/i.test(aria(x))));
      if (!b) return { ok: true, state: 'none', counter, seen };
      return place(b, { state: disabled(b) ? 'disabled' : 'found', counter, seen });
    }
    return { ok: false, error: `unknown step ${step}` };
  }

  // ---------- messaging ----------

  function handle(m) {
    switch (m.cmd) {
      case 'ping':
        return { ok: true };
      case 'configure':
        cfg = { ...cfg, ...m.cfg };
        if (!cfg.showCursor && dot) {
          dot.remove();
          dot = null;
        }
        return { ok: true };
      case 'viewport':
        return { ok: true, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, url: location.href, title: document.title };
      case 'scrollInfo': {
        // Some apps (e.g. LinkedIn) scroll an inner container, not the document: measure whatever
        // scrolls under the mouse.
        const n = scrollableAt(document.elementFromPoint(m.x, m.y) || document.body);
        const doc = n === document.scrollingElement || n === document.documentElement;
        return {
          ok: true,
          top: doc ? window.scrollY : n.scrollTop,
          height: n.scrollHeight,
          view: doc ? window.innerHeight : n.clientHeight,
        };
      }
      case 'resolve': {
        const el = document.querySelector(m.selector);
        if (!el) return { ok: false, error: 'selector not found' };
        const r = el.getBoundingClientRect();
        const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        return { ok: true, box: [r.left, r.top, r.right, r.bottom], inView };
      }
      case 'liConnect':
        return liConnect(m.step);
      case 'liInvite':
        return liInvite(m.step);
      case 'cursor':
        drawCursor(m.x, m.y, m.down);
        return { ok: true };
      case 'dom':
        dom(m);
        return { ok: true };
    }
    return { ok: false, error: 'unknown cmd' };
  }

  const onMessage = (m, _sender, sendResponse) => {
    if (!m || !m.stl) return;
    try {
      sendResponse(handle(m));
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  window.__stlTeardown = () => {
    clearInterval(watchTimer);
    dot?.remove();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {} // the extension was reloaded: this copy's runtime is gone
  };
})();
