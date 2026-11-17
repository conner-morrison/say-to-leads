// Screenshot capture + cheap change detection (tiny grayscale thumbnail diff),
// so the expensive AI step only runs when something on screen actually changed.

import { log } from './logger.js';

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms))]);
}

// Claude downsizes anything with a longer edge than this, so a bigger image only costs upload time.
const MAX_EDGE = 1568;

// The image sent is the page at Settings → Screenshot size for AI (scale) of its viewport size in CSS px
// (width = the viewport's, not the device pixels': a 2x display doesn't double it), capped at MAX_EDGE.
// Analyzer coordinates are normalized, so a smaller image needs no position conversion.
export async function captureTab(tab, { backend, profile, scale: setScale = 1, viewportWidth = 0 }) {
  let blob = null;
  if (backend?.kind === 'debugger' && backend.attached) {
    // CDP capture also works when the tab is not the focused one.
    try {
      blob = await withTimeout(backend.screenshot(profile.jpegQuality), 8000, 'CDP screenshot');
    } catch (e) {
      log.warn('CDP screenshot failed, falling back to captureVisibleTab', e.message);
    }
  }
  if (!blob) {
    const t = await chrome.tabs.get(tab.id);
    if (!t.active) throw new Error('TAB_NOT_VISIBLE');
    const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, {
      format: 'jpeg',
      quality: Math.round(profile.jpegQuality * 100),
    });
    blob = await (await fetch(dataUrl)).blob();
  }

  const bmp = await createImageBitmap(blob);
  let out = blob;
  let w = bmp.width;
  let h = bmp.height;
  const base = viewportWidth > 0 ? Math.min(1, viewportWidth / bmp.width) : 1;
  const want = base * Math.min(1, Math.max(0.1, setScale));
  const scale = Math.min(want, MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale < 1) {
    w = Math.round(bmp.width * scale);
    h = Math.round(bmp.height * scale);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    out = await c.convertToBlob({ type: 'image/jpeg', quality: profile.jpegQuality });
  }
  const thumb = makeThumb(bmp, profile.thumbSize);
  bmp.close();
  return { blob: out, width: w, height: h, thumb };
}

function makeThumb(bmp, size) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const g = new Uint8Array(size * size);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return g;
}

// Mean absolute difference 0..255. Infinity when there is nothing to compare.
export function diffThumbs(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
