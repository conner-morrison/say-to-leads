// Isolated-world content script, injected on Start into the linked tab.
// Jobs: report viewport/selector geometry, watch for new notifications/messages,
// execute DOM-driver input, draw the debug cursor.
(() => {
  if (window.__stlContent) return;
  window.__stlContent = true;

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
  setInterval(watchTick, 2000); // polling is cheaper than a page-wide MutationObserver on old CPUs

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
      case 'resolve': {
        const el = document.querySelector(m.selector);
        if (!el) return { ok: false, error: 'selector not found' };
        const r = el.getBoundingClientRect();
        const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        return { ok: true, box: [r.left, r.top, r.right, r.bottom], inView };
      }
      case 'cursor':
        drawCursor(m.x, m.y, m.down);
        return { ok: true };
      case 'dom':
        dom(m);
        return { ok: true };
    }
    return { ok: false, error: 'unknown cmd' };
  }

  chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
    if (!m || !m.stl) return;
    try {
      sendResponse(handle(m));
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  });
})();
