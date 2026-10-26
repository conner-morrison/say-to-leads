// Humanization primitives: randomness with realistic distributions, mouse paths,
// typing plans with typos, and click-point selection. Pure functions, no Chrome APIs.

export const rnd = (a, b) => a + Math.random() * (b - a);
export const rint = (a, b) => Math.floor(rnd(a, b + 1));
export const chance = (p) => Math.random() < p;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function gauss(mean = 0, sd = 1) {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Human reaction/interval times are right-skewed: log-normal fits them well.
export function logNormal(median, sigma = 0.35) {
  return median * Math.exp(gauss(0, sigma));
}

// A skewed value in [min, max], clustering around the geometric middle.
export function humanBetween(min, max, sigma = 0.3) {
  if (max <= min) return min;
  return clamp(logNormal(Math.sqrt(Math.max(min, 1) * max), sigma), min, max);
}

// Time to "read" text before reacting to it (~230 wpm, capped).
export function readingDelayMs(text = '') {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  return clamp(logNormal(300 + words * 260, 0.3), 250, 9000);
}

// ---------- Click target ----------

// box: [x1,y1,x2,y2] in px. Humans aim near the center but rarely hit it exactly.
export function pointInBox([x1, y1, x2, y2]) {
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const cx = x1 + w / 2;
  const cy = y1 + h / 2;
  const mx = Math.min(3, w / 2);
  const my = Math.min(3, h / 2);
  return {
    x: clamp(gauss(cx, w / 7), x1 + mx, x2 - mx),
    y: clamp(gauss(cy, h / 7), y1 + my, y2 - my),
  };
}

// Small jitter around a point (when only x/y is known).
export function jitterPoint(p, radius = 3) {
  return { x: p.x + gauss(0, radius / 2), y: p.y + gauss(0, radius / 2) };
}

// ---------- Mouse paths ----------

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Minimum-jerk easing: slow start, fast middle, slow arrival – like a real hand.
const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

function singlePath(from, to, profile, durationScale = 1) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return [{ x: to.x, y: to.y, dt: rint(8, 20) }];

  const steps = clamp(Math.round(dist / profile.mouseStepPx), 5, profile.mouseMaxSteps);
  // Fitts-like: longer moves take longer, with variance.
  const duration = clamp(logNormal(160 + 110 * Math.log2(dist / 15 + 1), 0.22), 110, 1800) * durationScale;

  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = gauss(0, dist * 0.1);
  const c1 = { x: from.x + dx * rnd(0.2, 0.4) + nx * bend * rnd(0.6, 1.2), y: from.y + dy * rnd(0.2, 0.4) + ny * bend * rnd(0.6, 1.2) };
  const c2 = { x: from.x + dx * rnd(0.6, 0.85) + nx * bend * rnd(0.2, 0.8), y: from.y + dy * rnd(0.6, 0.85) + ny * bend * rnd(0.2, 0.8) };

  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = minJerk(i / steps);
    const last = i === steps;
    pts.push({
      x: cubic(from.x, c1.x, c2.x, to.x, t) + (last ? 0 : gauss(0, 0.7)),
      y: cubic(from.y, c1.y, c2.y, to.y, t) + (last ? 0 : gauss(0, 0.7)),
      dt: (duration / steps) * rnd(0.75, 1.25),
    });
  }
  return pts;
}

// Full path, occasionally overshooting long moves and correcting back.
export function mousePath(from, to, profile) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist > 250 && chance(0.15)) {
    const ux = (to.x - from.x) / dist;
    const uy = (to.y - from.y) / dist;
    const over = rnd(6, 20);
    const mid = { x: to.x + ux * over + gauss(0, 3), y: to.y + uy * over + gauss(0, 3) };
    const a = singlePath(from, mid, profile);
    a.push({ x: mid.x, y: mid.y, dt: rint(40, 120) }); // tiny "oops" pause
    return a.concat(singlePath(mid, to, profile, 0.5));
  }
  return singlePath(from, to, profile);
}

// ---------- Typing ----------

const ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
function neighborKey(ch) {
  const lower = ch.toLowerCase();
  for (let r = 0; r < ROWS.length; r++) {
    const c = ROWS[r].indexOf(lower);
    if (c === -1) continue;
    const opts = [];
    if (c > 0) opts.push(ROWS[r][c - 1]);
    if (c < ROWS[r].length - 1) opts.push(ROWS[r][c + 1]);
    const pick = opts[rint(0, opts.length - 1)] || lower;
    return ch === lower ? pick : pick.toUpperCase();
  }
  return null;
}

// Returns steps: {kind:'char', ch, delay} | {kind:'backspace', delay} | {kind:'pause', delay}
export function typingPlan(text, { wpmMin, wpmMax, typoRate }) {
  const wpm = rnd(wpmMin, wpmMax); // one "mood" per message
  const base = 60000 / (wpm * 5); // ms per character
  const plan = [];
  let prev = '';
  for (const ch of String(text)) {
    let d = logNormal(base, 0.38);
    if (prev === ' ') d *= rnd(1.05, 1.5);
    if (/[.,!?;:]/.test(prev)) d += rnd(120, 450);
    if (chance(0.025)) d += rnd(300, 1100); // hesitation / thinking mid-sentence
    const wrong = /[a-z0-9]/i.test(ch) && chance(typoRate) ? neighborKey(ch) : null;
    if (wrong) {
      plan.push({ kind: 'char', ch: wrong, delay: d });
      // Sometimes the typo is noticed only after one more char.
      if (chance(0.3)) {
        plan.push({ kind: 'pause', delay: rnd(80, 200) });
        plan.push({ kind: 'char', ch, delay: logNormal(base, 0.3) });
        plan.push({ kind: 'pause', delay: rnd(200, 600) });
        plan.push({ kind: 'backspace', delay: logNormal(base * 0.9, 0.25) });
        plan.push({ kind: 'backspace', delay: logNormal(base * 0.9, 0.25) });
      } else {
        plan.push({ kind: 'pause', delay: rnd(180, 550) });
        plan.push({ kind: 'backspace', delay: logNormal(base, 0.25) });
      }
      plan.push({ kind: 'char', ch, delay: logNormal(base * 1.1, 0.3) });
    } else {
      plan.push({ kind: 'char', ch, delay: d });
    }
    prev = ch;
  }
  return plan;
}
