// Human-paced input on top of a low-level backend.
//  - CdpBackend: chrome.debugger Input.* → events are trusted (isTrusted=true), like a real user.
//    Chrome shows a "started debugging this browser" bar while attached.
//  - DomBackend: synthetic DOM events from the content script. No banner, but isTrusted=false,
//    so some sites ignore them. Good for testing.

import { mousePath, typingPlan, humanBetween, logNormal, rnd, clamp, gauss } from './human.js';

// ---------- key specs ----------

const NAMED = {
  Enter: ['Enter', 'Enter', 13, '\r'],
  Tab: ['Tab', 'Tab', 9],
  Backspace: ['Backspace', 'Backspace', 8],
  Escape: ['Escape', 'Escape', 27],
  Esc: ['Escape', 'Escape', 27],
  Delete: ['Delete', 'Delete', 46],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  Home: ['Home', 'Home', 36],
  End: ['End', 'End', 35],
  PageUp: ['PageUp', 'PageUp', 33],
  PageDown: ['PageDown', 'PageDown', 34],
  Space: [' ', 'Space', 32, ' '],
};
const MODS = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vk: 16 },
};

export function keySpec(k) {
  if (NAMED[k]) {
    const [key, code, vk, text] = NAMED[k];
    return { key, code, vk, text };
  }
  if (k.length === 1) {
    const up = k.toUpperCase();
    if (/[a-z]/i.test(k)) return { key: k, code: 'Key' + up, vk: up.charCodeAt(0), text: k };
    if (/\d/.test(k)) return { key: k, code: 'Digit' + k, vk: k.charCodeAt(0), text: k };
    return { key: k, code: '', vk: 0, text: k };
  }
  return { key: k, code: k, vk: 0 };
}

export function parseCombo(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
  const main = parts.pop() || 'Enter';
  const mods = parts.map((p) => MODS[p.toLowerCase()]).filter(Boolean);
  return { mods, bits: mods.reduce((b, m) => b | m.bit, 0), spec: keySpec(main) };
}

// ---------- backends ----------

export class CdpBackend {
  kind = 'debugger';

  constructor(tabId, onDetach) {
    this.tabId = tabId;
    this.attached = false;
    this.onDetachCb = onDetach;
    this._onDetach = (src, reason) => {
      if (src.tabId !== this.tabId) return;
      this.attached = false;
      this.onDetachCb?.(reason);
    };
  }

  async init() {
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    this.attached = true;
    chrome.debugger.onDetach.addListener(this._onDetach);
  }

  async dispose() {
    chrome.debugger.onDetach.removeListener(this._onDetach);
    if (this.attached) await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    this.attached = false;
  }

  send(method, params = {}) {
    if (!this.attached) throw new Error('debugger detached');
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  async screenshot(quality) {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: Math.round(quality * 100), fromSurface: true });
    return (await fetch('data:image/jpeg;base64,' + r.data)).blob();
  }

  mouseMove(x, y) {
    return this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  }
  mouseDown(x, y, button, clickCount) {
    return this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount });
  }
  mouseUp(x, y, button, clickCount) {
    return this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
  }
  wheel(x, y, dy) {
    return this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  }

  async keyDown(spec, bits) {
    const p = { type: spec.text && !(bits & 6) ? 'keyDown' : 'rawKeyDown', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers: bits };
    if (spec.text && !(bits & 6)) {
      p.text = spec.text;
      p.unmodifiedText = spec.text;
    }
    if (bits & 6 && spec.key.toLowerCase() === 'a') p.commands = ['selectAll'];
    return this.send('Input.dispatchKeyEvent', p);
  }
  keyUp(spec, bits) {
    return this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers: bits });
  }

  async char(ch) {
    if (/^[\x20-\x7e]$/.test(ch)) {
      const spec = keySpec(ch);
      const bits = /[A-Z]/.test(ch) ? 8 : 0;
      await this.keyDown(spec, bits);
      await this.keyUp(spec, bits);
    } else {
      await this.send('Input.insertText', { text: ch }); // emoji, non-latin scripts
    }
  }
}

export class DomBackend {
  kind = 'dom';

  constructor(tabId) {
    this.tabId = tabId;
  }
  async init() {}
  async dispose() {}

  call(op, args) {
    return chrome.tabs.sendMessage(this.tabId, { stl: true, cmd: 'dom', op, ...args }, { frameId: 0 });
  }
  mouseMove(x, y) {
    return this.call('move', { x, y });
  }
  mouseDown(x, y, button, clickCount) {
    return this.call('down', { x, y, button, clickCount });
  }
  mouseUp(x, y, button, clickCount) {
    return this.call('up', { x, y, button, clickCount });
  }
  wheel(x, y, dy) {
    return this.call('wheel', { x, y, dy });
  }
  keyDown(spec, bits) {
    return this.call('keydown', { spec, bits });
  }
  keyUp(spec, bits) {
    return this.call('keyup', { spec, bits });
  }
  char(ch) {
    return this.call('char', { ch });
  }
}

// ---------- humanizing layer ----------

export class HumanInput {
  constructor(backend, { profile, human, ctl, tabId, showCursor }) {
    this.backend = backend;
    this.profile = profile;
    this.human = human;
    this.ctl = ctl;
    this.tabId = tabId;
    this.showCursor = showCursor;
    this.pos = null;
    this.vp = { w: 1280, h: 720 };
  }

  setViewport(vp) {
    this.vp = vp;
    if (!this.pos) this.pos = { x: rnd(vp.w * 0.3, vp.w * 0.7), y: rnd(vp.h * 0.3, vp.h * 0.7) };
  }

  cursor(x, y, down = false) {
    if (!this.showCursor) return;
    chrome.tabs.sendMessage(this.tabId, { stl: true, cmd: 'cursor', x, y, down }, { frameId: 0 }).catch(() => {});
  }

  async move(to) {
    const target = { x: clamp(to.x, 1, this.vp.w - 2), y: clamp(to.y, 1, this.vp.h - 2) };
    for (const p of mousePath(this.pos, target, this.profile)) {
      await this.ctl.sleep(p.dt);
      const x = clamp(p.x, 0, this.vp.w - 1);
      const y = clamp(p.y, 0, this.vp.h - 1);
      await this.backend.mouseMove(x, y);
      this.pos = { x, y };
      this.cursor(x, y);
    }
  }

  async click(pt, { double = false, button = 'left' } = {}) {
    await this.move(pt);
    await this.ctl.sleep(humanBetween(60, 260)); // settle on the target
    const { x, y } = this.pos;
    const n = double ? 2 : 1;
    for (let i = 1; i <= n; i++) {
      await this.backend.mouseDown(x, y, button, i);
      this.cursor(x, y, true);
      await this.ctl.sleep(clamp(logNormal(90, 0.3), 45, 220));
      await this.backend.mouseUp(x, y, button, i);
      this.cursor(x, y, false);
      if (i < n) await this.ctl.sleep(rnd(70, 150));
    }
  }

  async press(combo) {
    const { mods, bits, spec } = parseCombo(combo);
    let held = 0;
    for (const m of mods) {
      held |= m.bit;
      await this.backend.keyDown({ key: m.key, code: m.code, vk: m.vk }, held);
      await this.ctl.sleep(rnd(35, 90));
    }
    await this.backend.keyDown(spec, bits);
    await this.ctl.sleep(clamp(logNormal(75, 0.3), 35, 180));
    await this.backend.keyUp(spec, bits);
    for (const m of mods.reverse()) {
      await this.ctl.sleep(rnd(20, 70));
      held &= ~m.bit;
      await this.backend.keyUp({ key: m.key, code: m.code, vk: m.vk }, held);
    }
  }

  async type(text) {
    for (const step of typingPlan(text, this.human)) {
      await this.ctl.sleep(step.delay);
      if (step.kind === 'pause') continue;
      if (step.kind === 'backspace') await this.press('Backspace');
      else if (step.ch === '\n') await this.press('Shift+Enter'); // newline without sending in most chat UIs
      else await this.backend.char(step.ch);
    }
  }

  async clearField() {
    await this.press('Ctrl+A');
    await this.ctl.sleep(humanBetween(120, 400));
    await this.press('Backspace');
  }

  // Scrolls in "flicks" of several wheel ticks with pauses between, like a mouse wheel.
  async scroll(dy) {
    const sign = Math.sign(dy) || 1;
    let left = Math.abs(dy);
    while (left > 0) {
      let flick = Math.min(left, rnd(180, 480));
      left -= flick;
      while (flick > 0) {
        const chunk = Math.min(flick, this.profile.scrollChunkPx * rnd(0.7, 1.3));
        flick -= chunk;
        await this.backend.wheel(this.pos.x, this.pos.y, sign * chunk);
        await this.ctl.sleep(rnd(14, 45));
      }
      if (left > 0) await this.ctl.sleep(humanBetween(250, 900));
    }
  }

  // Small aimless movement while "reading".
  async fidget() {
    const to = {
      x: clamp(this.pos.x + gauss(0, 60), 5, this.vp.w - 5),
      y: clamp(this.pos.y + gauss(0, 40), 5, this.vp.h - 5),
    };
    await this.move(to);
  }
}
